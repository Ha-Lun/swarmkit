import { open, readdir, readFile, stat } from 'node:fs/promises';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ServerEvent, SessionDetail, SessionSummary } from '../../src/shared/types.ts';
import { applyMessage, createTree, ensureNode, setStatus, upsertEvent, type SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';

export interface WatcherOptions {
  /** Defaults to ~/.claude/projects. */
  root?: string;
  /** Only sessions modified within this many ms are listed; default 24 h. */
  maxAgeMs?: number;
  emit: (e: ServerEvent) => void;
  /** True for session ids owned by the SDK manager (page sessions): the watcher skips them. */
  skip: (sessionId: string) => boolean;
}

interface HeadEntry {
  /** path:mtime:size cache key. */
  key: string;
  path: string;
  mtimeMs: number;
  size: number;
  cwd: string;
  title: string;
  agent?: string;
  startedAt: number;
}

interface SubState {
  offset: number;
  rest: Buffer;
}

interface LiveSession {
  id: string;
  path: string;
  tree: SessionTree;
  offset: number;
  rest: Buffer;
  mtimeMs: number;
  cwd: string;
  startedAt: number;
  subs: Map<string, SubState>;
  lastSummary: string;
}

const HEAD_BYTES = 64 * 1024;
const SCAN_MS = 2000;
/** Sessions younger than this are parsed eagerly by the scan loop. */
const LIVE_MS = 10 * 60_000;
/** A recently written session file counts as running in summaries. */
const RUNNING_MS = 2 * 60_000;

export class TranscriptWatcher {
  private readonly root: string;
  private readonly maxAgeMs: number;
  private readonly emitFn: (e: ServerEvent) => void;
  private readonly skipFn: (id: string) => boolean;
  private heads = new Map<string, HeadEntry>();
  private live = new Map<string, LiveSession>();
  private cwds = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(opts: WatcherOptions) {
    this.root = opts.root ?? join(homedir(), '.claude', 'projects');
    this.maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60_000;
    this.emitFn = opts.emit;
    this.skipFn = opts.skip;
  }

  /** Starts scanning and tailing; idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanNow().catch(() => {});
    }, SCAN_MS);
    this.timer.unref?.();
    void this.scanNow().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One scan pass: refresh the head cache, tail live sessions, poll workers. */
  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.refreshHeadsSync();
      const now = Date.now();
      for (const [id, head] of [...this.heads.entries()]) {
        if (this.live.has(id) || this.skipFn(id)) continue;
        if (now - head.mtimeMs < LIVE_MS) {
          try {
            const { live, events } = await this.parseFull(head.path, id);
            this.live.set(id, live);
            this.flushEvents(events, live);
          } catch {
            // unreadable session file: try again next pass
          }
        }
      }
      for (const live of [...this.live.values()]) {
        const events = await this.refreshLive(live);
        this.flushEvents(events, live);
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Terminal sessions, most recently updated first. */
  list(): SessionSummary[] {
    this.refreshHeadsSync();
    const out = new Map<string, SessionSummary>();
    for (const [id, head] of this.heads) {
      if (this.skipFn(id)) continue;
      out.set(id, headSummary(head));
    }
    for (const [id, live] of this.live) {
      if (this.skipFn(id)) continue;
      const head = this.heads.get(id);
      const summary = liveSummary(live);
      if (!summary.cwd && head) {
        summary.cwd = head.cwd;
        summary.project = basename(head.cwd);
      }
      if (!summary.title && head) summary.title = head.title;
      if (!summary.agent && head?.agent) summary.agent = head.agent;
      out.set(id, summary);
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Parses the session lazily on first call, then keeps tailing it. */
  async get(sessionId: string): Promise<SessionDetail | undefined> {
    if (this.skipFn(sessionId)) return undefined;
    let live = this.live.get(sessionId);
    if (!live) {
      const file = await this.findFile(sessionId);
      if (!file) return undefined;
      try {
        const parsed = await this.parseFull(file, sessionId);
        live = parsed.live;
        this.live.set(sessionId, parsed.live);
        this.flushEvents(parsed.events, parsed.live);
      } catch {
        return undefined;
      }
    }
    const events = await this.refreshLive(live);
    this.flushEvents(events, live);
    return this.detailFor(live);
  }

  /** Recent cwds from transcripts, most recent first. */
  recentCwds(): string[] {
    return [...this.cwds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cwd]) => cwd)
      .filter((cwd) => cwd.length > 0);
  }

  /** The tree node that started a worker with this lane+slug, in any live watcher tree. */
  findWorkerNode(lane: 'agy' | 'opencode', slug: string): { sessionId: string; nodeId: string } | undefined {
    for (const live of this.live.values()) {
      for (const node of live.tree.nodes.values()) {
        if (node.kind === 'worker' && node.worker?.lane === lane && node.worker?.slug === slug) {
          return { sessionId: live.id, nodeId: node.id };
        }
      }
    }
    return undefined;
  }

  /** cwd and transcript mtime of a terminal session, when the file is known. */
  fileInfo(id: string): { cwd: string; mtimeMs: number } | undefined {
    const live = this.live.get(id);
    if (live) return { cwd: live.cwd, mtimeMs: live.mtimeMs };
    const head = this.heads.get(id);
    if (head) return { cwd: head.cwd, mtimeMs: head.mtimeMs };
    return undefined;
  }

  // -------------------------------------------------------------------------

  private flushEvents(events: ServerEvent[], live: LiveSession): void {
    for (const e of events) this.emitFn(e);
    const summary = liveSummary(live);
    const key = JSON.stringify(summary);
    if (key !== live.lastSummary) {
      live.lastSummary = key;
      this.emitFn({ type: 'session.upsert', session: summary });
    }
  }

  /** Full parse of a session file plus its subagent files. */
  private async parseFull(file: string, id: string): Promise<{ live: LiveSession; events: ServerEvent[] }> {
    const [st, raw] = await Promise.all([stat(file), readFile(file)]);
    const { lines } = extractLines(raw);
    // Pre-scan for cwd / first timestamp / agent-setting before building the tree.
    let cwd = '';
    let sawTs = false;
    let startedAt = st.mtimeMs;
    let agentType: string | undefined;
    const msgs: Record<string, unknown>[] = [];
    for (const line of lines) {
      const m = parseJsonLine(line);
      if (!m) continue;
      msgs.push(m);
      const c = str(m.cwd);
      if (c && !cwd) cwd = c;
      const t = tsOf(m.timestamp);
      if (t && !sawTs) {
        startedAt = t;
        sawTs = true;
      }
      if (m.type === 'agent-setting') {
        const a = str(m.agentSetting);
        if (a) agentType = a;
      }
    }
    const tree = createTree(id, { startedAt, agentType });
    const live: LiveSession = {
      id,
      path: file,
      tree,
      offset: raw.length,
      rest: Buffer.alloc(0),
      mtimeMs: st.mtimeMs,
      cwd,
      startedAt,
      subs: new Map<string, SubState>(),
      lastSummary: '',
    };
    this.noteCwd(cwd, st.mtimeMs);
    const events: ServerEvent[] = [];
    for (const m of msgs) events.push(...applyMessage(tree, m));
    await this.ensureSubs(live, events, true);
    return { live, events };
  }

  /** Tails the main file, the subagent files and polls worker result files. */
  private async refreshLive(live: LiveSession): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    try {
      const st = await stat(live.path);
      live.mtimeMs = st.mtimeMs;
      if (st.size > live.offset) {
        const chunk = await readRange(live.path, live.offset);
        live.offset += chunk.length;
        const buf = Buffer.concat([live.rest, chunk]);
        const { lines, rest } = extractLines(buf);
        live.rest = rest;
        for (const line of lines) {
          const m = parseJsonLine(line);
          if (!m) continue;
          const c = str(m.cwd);
          if (c && !live.cwd) live.cwd = c;
          events.push(...applyMessage(live.tree, m));
        }
      }
    } catch {
      // missing/rotated file: keep the last parsed state
    }
    await this.ensureSubs(live, events, false);
    try {
      events.push(...(await pollWorkers(live.tree)));
    } catch {
      // worker result files unreadable: retry next pass
    }
    return events;
  }

  /** Discovers and tails subagents/agent-<agentId>.jsonl files for a live session. */
  private async ensureSubs(live: LiveSession, events: ServerEvent[], initial: boolean): Promise<void> {
    const subDir = join(dirname(live.path), live.id, 'subagents');
    let entries: Dirent[];
    try {
      entries = await readdir(subDir, { withFileTypes: true });
    } catch {
      void initial;
      return;
    }
    for (const e of entries) {
      if (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()) continue;
      if (typeof e.isFile === 'function' && !e.isFile()) continue;
      if (!e.name.endsWith('.jsonl')) continue;
      const path = join(subDir, e.name);
      let state = live.subs.get(path);
      if (!state) {
        state = { offset: 0, rest: Buffer.alloc(0) };
        live.subs.set(path, state);
      }
      try {
        await this.syncSub(live, path, state, events);
      } catch {
        // unreadable subagent file: retry next pass
      }
    }
  }

  private async syncSub(live: LiveSession, path: string, state: SubState, events: ServerEvent[]): Promise<void> {
    const meta = await readMeta(path);
    const nodeId = str(meta.toolUseId);
    if (!nodeId) return;
    if (!live.tree.nodes.has(nodeId)) {
      // The Agent tool_use was not seen in the main thread: build the node from the meta.
      const node = ensureNode(live.tree, nodeId, {
        kind: 'subagent',
        agentType: str(meta.agentType) ?? 'general-purpose',
        description: str(meta.description),
        model: str(meta.model),
        startedAt: Date.now(),
      });
      events.push(upsertEvent(node));
    }
    const chunk = await readRange(path, state.offset).catch(() => Buffer.alloc(0));
    if (chunk.length > 0) {
      state.offset += chunk.length;
      const buf = Buffer.concat([state.rest, chunk]);
      const { lines, rest } = extractLines(buf);
      state.rest = rest;
      for (const line of lines) {
        const m = parseJsonLine(line);
        if (m) events.push(...applyMessage(live.tree, m, { nodeId }));
      }
    }
    if (meta.finished === true) {
      const node = live.tree.nodes.get(nodeId);
      if (node && (node.status === 'running' || node.status === 'waiting')) {
        events.push(...setStatus(live.tree, nodeId, 'done'));
      }
    }
  }

  /** Sync head-cache refresh for list(); reads at most 64 KB per main file. */
  private refreshHeadsSync(): void {
    let projects: Dirent[];
    try {
      projects = readdirSync(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    const alive = new Set<string>();
    for (const d of projects) {
      if (d.isSymbolicLink() || !d.isDirectory()) continue;
      let files: Dirent[];
      try {
        files = readdirSync(join(this.root, d.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          if (f.isSymbolicLink() || !f.isFile()) continue;
          if (!f.name.endsWith('.jsonl')) continue;
          const id = f.name.slice(0, -'.jsonl'.length);
          if (this.skipFn(id)) continue;
          const path = join(this.root, d.name, f.name);
          const st = statSync(path);
          if (now - st.mtimeMs > this.maxAgeMs) continue;
          alive.add(id);
          const key = `${path}:${st.mtimeMs}:${st.size}`;
          const cur = this.heads.get(id);
          if (!cur || cur.key !== key) {
            this.heads.set(id, readHeadSync(path, st, key));
          } else {
            cur.mtimeMs = st.mtimeMs;
          }
          this.noteCwd(this.heads.get(id)?.cwd ?? '', st.mtimeMs);
        } catch {
          // unreadable file: skip
        }
      }
    }
    for (const id of [...this.heads.keys()]) {
      if (!alive.has(id)) this.heads.delete(id);
    }
  }

  private noteCwd(cwd: string, mtimeMs: number): void {
    if (cwd && (!this.cwds.has(cwd) || this.cwds.get(cwd)! < mtimeMs)) {
      this.cwds.set(cwd, mtimeMs);
    }
  }

  private async findFile(sessionId: string): Promise<string | undefined> {
    let projects: Dirent[];
    try {
      projects = await readdir(this.root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const d of projects) {
      if (d.isSymbolicLink?.() || !d.isDirectory?.()) continue;
      const path = join(this.root, d.name, `${sessionId}.jsonl`);
      try {
        const st = await stat(path);
        if (st.isFile() && !st.isSymbolicLink()) return path;
      } catch {
        // next project dir
      }
    }
    return undefined;
  }

  private detailFor(live: LiveSession): SessionDetail {
    const summary = liveSummary(live);
    const head = this.heads.get(live.id);
    if (!summary.cwd && head) summary.cwd = head.cwd;
    if (!summary.title && head) summary.title = head.title;
    return {
      ...summary,
      project: basename(summary.cwd),
      nodes: [...live.tree.nodes.values()],
      permissions: [],
    };
  }
}

// ---------------------------------------------------------------------------
// summaries
// ---------------------------------------------------------------------------

function liveSummary(live: LiveSession): SessionSummary {
  const nodes = [...live.tree.nodes.values()];
  const root = nodes.find((n) => n.id === 'root');
  const now = Date.now();
  const status =
    now - live.mtimeMs < RUNNING_MS || nodes.some((n) => n.status === 'waiting') ? 'running' : 'done';
  return {
    id: live.id,
    source: 'terminal',
    project: basename(live.cwd),
    cwd: live.cwd,
    title: root?.description ?? root?.prompt ?? '',
    status,
    startedAt: live.startedAt,
    updatedAt: live.mtimeMs,
    costUsd: nodes.reduce((sum, n) => sum + n.costUsd, 0),
    agent: root && root.agentType !== 'main' ? root.agentType : undefined,
    model: root?.model,
    nodeCount: nodes.length,
    pendingPermissions: 0,
  };
}

function headSummary(head: HeadEntry): SessionSummary {
  const now = Date.now();
  return {
    id: basename(head.path, '.jsonl'),
    source: 'terminal',
    project: basename(head.cwd),
    cwd: head.cwd,
    title: head.title,
    status: now - head.mtimeMs < RUNNING_MS ? 'running' : 'done',
    startedAt: head.startedAt,
    updatedAt: head.mtimeMs,
    costUsd: 0,
    agent: head.agent,
    nodeCount: 1,
    pendingPermissions: 0,
  };
}

// ---------------------------------------------------------------------------
// file helpers (only *.jsonl and *.meta.json are read; symlinks are ignored)
// ---------------------------------------------------------------------------

/** Splits a buffer into complete newline-terminated lines, keeping the trailing partial line. */
function extractLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    let line = buf.subarray(start, nl).toString('utf8');
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim().length > 0) lines.push(line);
    start = nl + 1;
  }
  return { lines, rest: buf.subarray(start) };
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readRange(path: string, offset: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const st = await handle.stat();
    const length = Math.max(0, st.size - offset);
    if (length === 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function readHeadSync(path: string, st: { mtimeMs: number; size: number }, key: string): HeadEntry {
  const head: HeadEntry = { key, path, mtimeMs: st.mtimeMs, size: st.size, cwd: '', title: '', startedAt: st.mtimeMs };
  const handle = openSync(path, 'r');
  try {
    const length = Math.min(HEAD_BYTES, st.size);
    const buf = Buffer.alloc(length);
    readSync(handle, buf, 0, length, 0);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n'); // drop a possibly truncated last line
    const complete = cut >= 0 ? text.slice(0, cut) : '';
    let sawTs = false;
    for (const line of complete.split('\n')) {
      // One bad line must not break the head parsing.
      const m = parseJsonLine(line.trim());
      if (!m) continue;
      const c = str(m.cwd);
      if (c && !head.cwd) head.cwd = c;
      const t = tsOf(m.timestamp);
      if (t && !sawTs) {
        head.startedAt = t;
        sawTs = true;
      }
      if (m.type === 'agent-setting') {
        const a = str(m.agentSetting);
        if (a) head.agent = a;
      }
      if (!head.title) {
        const message = asRaw(m.message);
        const content = message?.content;
        if (typeof content === 'string' && content.length > 0 && !content.startsWith('<')) {
          head.title = firstLine(content, 120);
        }
      }
    }
    return head;
  } finally {
    closeSync(handle);
  }
}

async function readMeta(jsonlPath: string): Promise<Record<string, unknown>> {
  try {
    const metaPath = `${jsonlPath.slice(0, -'.jsonl'.length)}.meta.json`;
    const raw = await readFile(metaPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function tsOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n', 1)[0] ?? text;
  return line.length > max ? line.slice(0, max) : line;
}

function asRaw(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
