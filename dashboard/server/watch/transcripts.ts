import { setImmediate } from 'node:timers/promises';
import { readdir, readFile, stat } from 'node:fs/promises';
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ServerEvent, SessionDetail, SessionSummary } from '../../src/shared/types.ts';
import { applyMessage, createTree, ensureNode, markPlaceholder, setStatus, upsertEvent, type SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';
import { claudeConfigDir } from '../paths.ts';
import { extractLines, parseObject, readRange } from '../fsutil.ts';

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
  /** Last time get() was called for this session. */
  lastAccess: number;
  lastSummary: string;
}

const HEAD_BYTES = 64 * 1024;
const SCAN_MS = 2000;
/** Sessions older than this mtime age are no longer parsed eagerly by the scan loop. */
const PARSE_FRESH_MS = 2 * 60_000;
/** At most this many sessions are fully parsed per scan tick. */
const PARSE_PER_TICK = 2;
/** Above this file size only the tail is parsed (the head's title is already known). */
const TAIL_BYTES = 4 * 1024 * 1024;
/** Yield to the event loop between this many applied lines. */
const LINE_CHUNK = 2000;
/** Sessions newer than this mtime age are classified as running in summaries. */
const LIVE_MS = 10 * 60_000;
/** A freshly written session file counts as running in summaries. */
const RUNNING_MS = 2 * 60_000;
/** A live session not accessed via get() within this many ms can be evicted (when also mtime-stale). */
const ACCESS_MS = 10 * 60_000;
/** Live sessions are capped; the LRU (by lastAccess / mtime) is dropped beyond this. */
const MAX_LIVE = 20;
/** Cached meta.json entries per watcher. */
const MAX_META_CACHE = 500;

export class TranscriptWatcher {
  private readonly root: string;
  private readonly maxAgeMs: number;
  private readonly emitFn: (e: ServerEvent) => void;
  private readonly skipFn: (id: string) => boolean;
  private heads = new Map<string, HeadEntry>();
  private live = new Map<string, LiveSession>();
  private cwds = new Map<string, number>();
  private metaCache = new Map<string, { mtimeMs: number; size: number; data: Record<string, unknown> }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(opts: WatcherOptions) {
    this.root = opts.root ?? join(claudeConfigDir(), 'projects');
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

  /** One scan pass: refresh the head cache, lazily parse very fresh sessions, tail live sessions, poll workers. */
  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      this.refreshHeadsSync();
      const now = Date.now();
      await this.evictLive(now);
      // Only sessions modified in the last 2 min are parsed eagerly (at most 2 per tick).
      const fresh: { id: string; head: HeadEntry }[] = [];
      for (const [id, head] of [...this.heads.entries()]) {
        if (this.live.has(id) || this.skipFn(id)) continue;
        if (now - head.mtimeMs < PARSE_FRESH_MS) fresh.push({ id, head });
      }
      fresh.sort((a, b) => b.head.mtimeMs - a.head.mtimeMs);
      let parsed = 0;
      for (const { id, head } of fresh) {
        if (parsed >= PARSE_PER_TICK) break;
        try {
          const { live, events } = await this.parseFull(head.path, id);
          this.live.set(id, live);
          this.flushEvents(events, live);
          parsed++;
        } catch {
          // unreadable session file: try again next pass
        }
      }
      // Eager parses can have overshot the cap again: trim once more.
      await this.trimLiveToCap();
      for (const [id, entry] of [...this.live.entries()]) {
        if (this.skipFn(id)) {
          this.live.delete(id);
          continue;
        }
        const events = await this.refreshLive(entry);
        this.flushEvents(events, this.live.get(id) ?? entry);
      }
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Drops live sessions that aged out: mtime older than LIVE_MS and not accessed via get()
   * within ACCESS_MS, or whose file is gone; also caps the map at MAX_LIVE (LRU). A final
   * session.upsert (from the head cache when present) is emitted before each drop.
   */
  private async evictLive(now: number): Promise<void> {
    const drop: string[] = [];
    for (const [id, live] of [...this.live.entries()]) {
      const stale = now - live.mtimeMs > LIVE_MS;
      const unaccessed = now - live.lastAccess > ACCESS_MS;
      if (this.skipFn(id) || (stale && unaccessed)) {
        drop.push(id);
        continue;
      }
      if (stale) {
        // mtime-stale but recently accessed: the file may still have been deleted.
        try {
          await stat(live.path);
        } catch {
          drop.push(id);
        }
      }
    }
    await this.dropLive(drop);
    if (this.live.size > MAX_LIVE) await this.trimLiveToCap();
  }

  /** Cap-only LRU trim (used after eager parses): no file probing needed. */
  private async trimLiveToCap(): Promise<void> {
    if (this.live.size <= MAX_LIVE) return;
    const candidates = [...this.live.keys()];
    candidates.sort((a, b) => {
      const la = this.live.get(a)!;
      const lb = this.live.get(b)!;
      const ka = Math.max(la.lastAccess, la.mtimeMs);
      const kb = Math.max(lb.lastAccess, lb.mtimeMs);
      return ka - kb;
    });
    const over = candidates.length - MAX_LIVE;
    await this.dropLive(candidates.slice(0, over));
  }

  /** The shared drop step: final session.upsert then delete. */
  private async dropLive(ids: string[]): Promise<void> {
    for (const id of ids) {
      const live = this.live.get(id);
      if (!live) continue;
      const head = this.heads.get(id);
      this.emitFn({
        type: 'session.upsert',
        session: head ? headSummary(head) : liveSummary(live),
      });
      this.live.delete(id);
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
    live.lastAccess = Date.now();
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
    for (const [id, live] of this.live.entries()) {
      if (this.skipFn(id)) {
        this.live.delete(id);
        continue;
      }
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

  /** Full parse of a session file plus its subagent files; tail-only above TAIL_BYTES. */
  private async parseFull(file: string, id: string): Promise<{ live: LiveSession; events: ServerEvent[] }> {
    const st = await stat(file);
    let start = 0;
    if (st.size > TAIL_BYTES) start = st.size - TAIL_BYTES;
    let raw = await readRange(file, start);
    if (start > 0) {
      // Cut ends at the first newline after the truncation point; the head's first-prompt title is known.
      const nl = raw.indexOf(0x0a);
      if (nl >= 0) {
        start += nl + 1;
        raw = raw.subarray(nl + 1);
      } else {
        start += raw.length;
        raw = Buffer.alloc(0);
      }
    }
    const { lines, rest } = extractLines(raw);
    // Kept for the next tail: the bytes after the last complete newline, never re-parsed.
    const offset = start + (raw.length - rest.length);
    // Pre-scan for cwd / first timestamp / agent-setting before building the tree.
    let cwd = '';
    let sawTs = false;
    let startedAt = st.mtimeMs;
    let agentType: string | undefined;
    const msgs: Record<string, unknown>[] = [];
    for (const line of lines) {
      const m = parseObject(line);
      if (Object.keys(m).length === 0) continue;
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
    // A tail-only start has no first timestamp: the head read already established it.
    if (start > 0) {
      const head = this.heads.get(id);
      if (head) startedAt = head.startedAt;
    }
    const tree = createTree(id, { startedAt, agentType });
    if (cwd) tree.cwd = cwd;
    const live: LiveSession = {
      id,
      path: file,
      tree,
      offset,
      rest,
      mtimeMs: st.mtimeMs,
      cwd,
      startedAt,
      subs: new Map<string, SubState>(),
      lastAccess: Date.now(),
      lastSummary: '',
    };
    this.noteCwd(cwd, st.mtimeMs);
    const events: ServerEvent[] = [];
    for (let i = 0; i < msgs.length; i += LINE_CHUNK) {
      for (const m of msgs.slice(i, i + LINE_CHUNK)) events.push(...applyMessage(tree, m));
      if (i + LINE_CHUNK < msgs.length) await setImmediate();
    }
    await this.ensureSubs(live, events);
    return { live, events };
  }

  /** Tails the main file, the subagent files and polls worker result files. */
  private async refreshLive(live: LiveSession): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    let truncated = false;
    try {
      const st = await stat(live.path);
      // rest already holds the bytes after the last complete newline: never read them twice.
      const readFrom = live.offset + live.rest.length;
      truncated = st.size < readFrom; // truncated or rewritten from scratch
      live.mtimeMs = st.mtimeMs;
      if (!truncated && st.size > readFrom) {
        const chunk = await readRange(live.path, readFrom);
        const buf = Buffer.concat([live.rest, chunk]);
        const { lines, rest } = extractLines(buf);
        live.rest = rest;
        live.offset = readFrom + chunk.length - rest.length;
        for (const line of lines) {
          const m = parseObject(line);
          if (Object.keys(m).length === 0) continue;
          const c = str(m.cwd);
          if (c && !live.cwd) live.cwd = c;
          events.push(...applyMessage(live.tree, m));
        }
      }
    } catch {
      // missing/rotated file: keep the last parsed state
    }
    if (!truncated) {
      truncated = await this.ensureSubs(live, events);
    }
    if (truncated) return this.rebuild(live);
    try {
      events.push(...(await pollWorkers(live.tree)));
    } catch {
      // worker result files unreadable: retry next pass
    }
    return events;
  }

  /**
   * A main or subagent file was truncated/rewritten: rebuild the tree from scratch and emit
   * node.upserts for every node plus a session.upsert.
   */
  private async rebuild(live: LiveSession): Promise<ServerEvent[]> {
    const events: ServerEvent[] = [];
    try {
      const parsed = await this.parseFull(live.path, live.id);
      this.live.set(live.id, parsed.live);
      for (const node of parsed.live.tree.nodes.values()) {
        events.push(upsertEvent(node));
      }
      events.push({ type: 'session.upsert', session: liveSummary(parsed.live) });
    } catch {
      // file vanished mid-rebuild: the old state stands
    }
    return events;
  }

  /** Discovers and tails subagents/agent-<agentId>.jsonl files for a live session. */
  private async ensureSubs(live: LiveSession, events: ServerEvent[]): Promise<boolean> {
    const subDir = join(dirname(live.path), live.id, 'subagents');
    let entries: Dirent[];
    try {
      entries = await readdir(subDir, { withFileTypes: true });
    } catch {
      return false;
    }
    const seen = new Set<string>();
    for (const e of entries) {
      if (typeof e.isSymbolicLink === 'function' && e.isSymbolicLink()) continue;
      if (typeof e.isFile === 'function' && !e.isFile()) continue;
      if (!e.name.endsWith('.jsonl')) continue;
      const path = join(subDir, e.name);
      seen.add(path);
      let state = live.subs.get(path);
      if (!state) {
        state = { offset: 0, rest: Buffer.alloc(0) };
        live.subs.set(path, state);
      }
      try {
        const truncated = await this.syncSub(live, path, state, events);
        if (truncated) return true;
      } catch {
        // unreadable subagent file: retry next pass
      }
    }
    if (live.subs.size > 50) { // keep the sub map bounded
      for (const path of [...live.subs.keys()]) {
        if (!seen.has(path)) live.subs.delete(path);
      }
    }
    return false;
  }

  /** Returns true when the subagent file was truncated/rewritten (the session is rebuilt). */
  private async syncSub(live: LiveSession, path: string, state: SubState, events: ServerEvent[]): Promise<boolean> {
    let st;
    try {
      st = await stat(path);
    } catch {
      // unreadable subagent file: retry next pass
      return false;
    }
    if (st.size < state.offset + state.rest.length) return true; // truncated/rewritten subagent file
    const meta = await this.readMetaCached(path);
    const nodeId = str(meta.toolUseId);
    if (!nodeId) return false;
    if (!live.tree.nodes.has(nodeId)) {
      // The Agent tool_use was not seen in the main thread: build the node from the meta.
      const node = ensureNode(live.tree, nodeId, {
        kind: 'subagent',
        agentType: str(meta.agentType) ?? 'general-purpose',
        description: str(meta.description),
        model: str(meta.model),
        startedAt: Date.now(),
      });
      markPlaceholder(live.tree, nodeId);
      events.push(upsertEvent(node));
    }
    if (state.offset === 0 && state.rest.length === 0) {
      // Initial read; above TAIL_BYTES the subagent file is tail-only.
      let start = 0;
      if (st.size > TAIL_BYTES) start = st.size - TAIL_BYTES;
      let chunk = await readRange(path, start);
      if (start > 0) {
        const nl = chunk.indexOf(0x0a);
        if (nl >= 0) {
          start += nl + 1;
          chunk = chunk.subarray(nl + 1);
        } else {
          start += chunk.length;
          chunk = Buffer.alloc(0);
        }
      }
      const { lines, rest } = extractLines(chunk);
      state.offset = start + (chunk.length - rest.length);
      state.rest = rest;
      for (const line of lines) {
        const m = parseObject(line);
        if (Object.keys(m).length > 0) events.push(...applyMessage(live.tree, m, { nodeId }));
      }
      this.finishSubMeta(live, meta, nodeId, events);
      return false;
    }
    // Incremental tail: rest already holds the bytes after the last newline from the read before last.
    const readFrom = state.offset + state.rest.length;
    const incChunk = await readRange(path, readFrom).catch(() => Buffer.alloc(0));
    if (incChunk.length > 0) {
      const buf = Buffer.concat([state.rest, incChunk]);
      const { lines, rest } = extractLines(buf);
      state.rest = rest;
      state.offset = readFrom + incChunk.length - rest.length;
      for (const line of lines) {
        const m = parseObject(line);
        if (Object.keys(m).length > 0) events.push(...applyMessage(live.tree, m, { nodeId }));
      }
    }
    this.finishSubMeta(live, meta, nodeId, events);
    return false;
  }

  /** Marks a subagent done when its meta.json reports finished. */
  private finishSubMeta(
    live: LiveSession,
    meta: Record<string, unknown>,
    nodeId: string,
    events: ServerEvent[],
  ): void {
    if (meta.finished !== true) return;
    const node = live.tree.nodes.get(nodeId);
    if (node && (node.status === 'running' || node.status === 'waiting')) {
      events.push(...setStatus(live.tree, nodeId, 'done'));
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

  /** Reads <name>.meta.json next to a subagent file, cached by (mtime,size). */
  private async readMetaCached(jsonlPath: string): Promise<Record<string, unknown>> {
    const metaPath = `${jsonlPath.slice(0, -'.jsonl'.length)}.meta.json`;
    const st = await stat(metaPath).catch(() => undefined);
    if (!st) return {};
    const cached = this.metaCache.get(metaPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
    const data = parseObject(await readFile(metaPath, 'utf8').catch(() => undefined));
    this.metaCache.set(metaPath, { mtimeMs: st.mtimeMs, size: st.size, data });
    if (this.metaCache.size > MAX_META_CACHE) {
      this.metaCache.delete(this.metaCache.keys().next().value!);
    }
    return data;
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

function readHeadSync(path: string, st: { mtimeMs: number; size: number }, key: string): HeadEntry {
  const head: HeadEntry = { key, path, mtimeMs: st.mtimeMs, cwd: '', title: '', startedAt: st.mtimeMs };
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
      const m = parseObject(line.trim());
      if (Object.keys(m).length === 0) continue;
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
