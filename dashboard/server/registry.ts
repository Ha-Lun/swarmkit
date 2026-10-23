// Workers registry: scans agy-task / opencode-task task dirs (<root>/<repo>/<slug>/) and
// reports their live state, mirroring scripts/agy-task (see alive(), list_extra(), tool_failure()).
import { open, lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { WorkerTask } from '../src/shared/types';

/** Matches the permission refusals opencode writes into its JSON stream (same as agy-task's DENIED). */
const DENIED = /rule which prevents|permission|rejected/i;
/** Scan cadence and how much of a log file is read (tail). */
const SCAN_MS = 3_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
/** Task dirs older than this are not listed. */
const FRESH_MS = 7 * 24 * 60 * 60_000;
/** repo/slug name validation for log(). */
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/;
const LANES = ['agy', 'opencode'] as const;
type Lane = (typeof LANES)[number];

export interface WorkerLink {
  sessionId: string;
  nodeId: string;
}

export interface RegistryOptions {
  emit: (e: { type: 'workers.update'; workers: WorkerTask[] }) => void;
  /** Task-dir roots; default to AGY_TASK_DIR / OPENCODE_TASK_DIR or the home dirs. */
  agyRoot?: string;
  opencodeRoot?: string;
  /** Finds the tree node that started a worker, when any known session has one. */
  link?: (lane: Lane, slug: string) => WorkerLink | undefined;
  /** Liveness probe (pid -> running worker?); injectable so tests can fake a live task. */
  isAlive?: (pid: number) => Promise<boolean> | boolean;
}

interface ParsedLog {
  toolCounts: Record<string, number>;
  lastTool?: string;
  denied: number;
}

/** Incremental opencode.log read state for one task dir. */
interface LogCacheEntry extends ParsedLog {
  mtimeMs: number;
  size: number;
  /** Offset of complete-line consumption (next append starts here). */
  offset: number;
  /** Unparsed trailing partial line after offset. */
  rest: Buffer;
}

/** Default liveness check, exactly scripts/agy-task's alive(): the pid must be a live task CLI. */
async function defaultIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`);
    return cmdline.includes('agy-task') || cmdline.includes('opencode-task');
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

function parseObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

/** One readable arg for a tool_use line: `edit src/app.ts` style. */
function toolArg(tool: unknown, input: unknown): string {
  const i = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const raw = str(i.filePath) ?? str(i.path) ?? str(i.pattern) ?? str(i.command);
  return raw ? `${str(tool) ?? 'tool'} ${raw.slice(0, 80)}` : str(tool) ?? 'tool';
}

/** Parses one opencode.log JSON line into the (clock, text) log rendering, or undefined to skip it. */
function renderEvent(e: Record<string, unknown>): string | undefined {
  const clock = clockOf(e.timestamp);
  if (e.type === 'text') {
    const text = str((e.part as Record<string, unknown> | undefined)?.text)?.trim();
    if (!text) return undefined;
    // One line per event, also for multi-line texts.
    return `${clock} text: ${text.replace(/\s+/g, ' ').slice(0, 160)}`;
  }
  if (e.type === 'tool_use') {
    const part = (e.part ?? {}) as Record<string, unknown>;
    const state = (part.state ?? {}) as Record<string, unknown>;
    return `${clock} tool ${toolArg(part.tool, state.input)} ${str(state.status) ?? '?'}`;
  }
  if (e.type === 'step_finish') return `${clock} step finish`;
  return undefined;
}

function clockOf(v: unknown): string {
  let t: number;
  if (typeof v === 'number' && Number.isFinite(v)) t = v < 1e12 ? v * 1000 : v;
  else if (typeof v === 'string') t = Date.parse(v);
  else return '--:--:--';
  if (Number.isNaN(t)) return '--:--:--';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Reads at most the last `max` bytes of a file. */
async function readTail(path: string, max: number): Promise<string | undefined> {
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const st = await handle.stat();
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, st.size - len);
    return buf.toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

export class WorkerRegistry {
  private readonly emitFn: RegistryOptions['emit'];
  private readonly agyRoot?: string;
  private readonly opencodeRoot?: string;
  private readonly linkFn?: RegistryOptions['link'];
  private readonly isAlive: (pid: number) => Promise<boolean> | boolean;
  private timer: NodeJS.Timeout | undefined;
  private scanning = false;
  private cached: WorkerTask[] = [];
  private lastSig = '';
  private logCache = new Map<string, LogCacheEntry>();

  constructor(opts: RegistryOptions) {
    this.emitFn = opts.emit;
    this.agyRoot = opts.agyRoot;
    this.opencodeRoot = opts.opencodeRoot;
    this.linkFn = opts.link;
    this.isAlive = opts.isAlive ?? defaultIsAlive;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scanNow().catch(() => {});
    }, SCAN_MS);
    this.timer.unref();
    void this.scanNow().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Last scanned list (empty before the first scan). */
  list(): WorkerTask[] {
    return this.cached;
  }

  private laneRoot(lane: Lane): string {
    if (lane === 'agy') {
      return this.agyRoot ?? process.env.AGY_TASK_DIR ?? join(homedir(), '.agy-tasks');
    }
    return this.opencodeRoot ?? process.env.OPENCODE_TASK_DIR ?? join(homedir(), '.opencode-tasks');
  }

  /** One scan pass: refresh the cache and emit workers.update when the list changed. */
  async scanNow(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const workers: WorkerTask[] = [];
      const now = Date.now();
      for (const lane of LANES) {
        const root = this.laneRoot(lane);
        let repos: Dirent[];
        try {
          repos = await readdir(root, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const repoEntry of repos) {
          if (!repoEntry.isDirectory()) continue;
          let slugs: Dirent[];
          try {
            slugs = await readdir(join(root, repoEntry.name), { withFileTypes: true });
          } catch {
            continue;
          }
          for (const slugEntry of slugs) {
            if (!slugEntry.isDirectory()) continue;
            const dir = join(root, repoEntry.name, slugEntry.name);
            try {
              const dirSt = await stat(dir);
              if (now - dirSt.mtimeMs > FRESH_MS) continue;
              const task = await this.readTask(lane, repoEntry.name, slugEntry.name, dir, dirSt.mtimeMs);
              if (task) workers.push(task);
            } catch {
              // unreadable dir: skip
            }
          }
        }
      }
      workers.sort((a, b) => {
        const ra = a.state === 'running' ? 0 : 1;
        const rb = b.state === 'running' ? 0 : 1;
        return ra - rb || b.startedAt - a.startedAt;
      });
      // Change detection via the fields that can move, in 5 s elapsed buckets, not full JSON.
      const sig = signatureOf(workers);
      if (sig !== this.lastSig) {
        this.lastSig = sig;
        this.cached = workers;
        this.emitFn({ type: 'workers.update', workers });
      }
    } finally {
      this.scanning = false;
    }
  }

  /** Reads one <root>/<repo>/<slug>/ directory into a WorkerTask, or undefined when it has no files yet. */
  private async readTask(
    lane: Lane,
    repo: string,
    slug: string,
    dir: string,
    dirMtimeMs: number,
  ): Promise<WorkerTask | undefined> {
    const [pidText, optsText, baseText, resultText] = await Promise.all([
      readText(join(dir, 'pid')),
      readText(join(dir, 'opts.json')),
      readText(join(dir, 'base')),
      readText(join(dir, 'result.json')),
    ]);
    if (pidText === undefined && baseText === undefined && resultText === undefined && optsText === undefined) {
      return undefined;
    }
    const opts = parseObject(optsText);
    const result = parseObject(resultText);
    const pid = pidText !== undefined ? Number.parseInt(pidText.trim(), 10) : Number.NaN;
    const running = Number.isInteger(pid) && pid > 0 && (await this.isAlive(pid));

    const pidSt = pidText !== undefined ? await stat(join(dir, 'pid')).catch(() => undefined) : undefined;
    const baseSt = baseText !== undefined ? await stat(join(dir, 'base')).catch(() => undefined) : undefined;
    const startedAt = pidSt?.mtimeMs ?? baseSt?.mtimeMs ?? dirMtimeMs;
    const resultSt = resultText !== undefined ? await stat(join(dir, 'result.json')).catch(() => undefined) : undefined;
    const endedAt = resultSt?.mtimeMs;

    const now = Date.now();
    const state: WorkerTask['state'] = running
      ? 'running'
      : resultText !== undefined
        ? result.ok === true ? 'ok' : 'not-ok'
        : 'unfinished';
    const elapsedS = running
      ? Math.max(0, Math.round((now - startedAt) / 1000))
      : typeof result.wall_s === 'number' && Number.isFinite(result.wall_s)
        ? Math.round(result.wall_s)
        : endedAt !== undefined
          ? Math.max(0, Math.round((endedAt - startedAt) / 1000))
          : 0;

    let denied = 0;
    let toolCounts: Record<string, number> = {};
    let lastTool: string | undefined;
    if (running && lane === 'opencode') {
      const parsedLog = await this.readOpencodeLogCached(dir);
      if (parsedLog) {
        denied = parsedLog.denied;
        toolCounts = parsedLog.toolCounts;
        lastTool = parsedLog.lastTool;
      }
    } else if (!running && resultText !== undefined) {
      // no longer running: the cached incremental log state is obsolete then
      const deniedActions = result.denied_actions;
      denied = Array.isArray(deniedActions) ? deniedActions.length : 0;
    }

    const model = str(result.model) ?? str(opts.model);
    const effort = str(opts.effort);
    const agent = str(result.agent) ?? str(opts.agent);
    const link = this.linkFn?.(lane, slug);
    const task: WorkerTask = {
      lane,
      repo,
      slug,
      state,
      startedAt,
      elapsedS,
      denied,
      toolCounts,
    };
    if (model) task.model = model;
    if (effort) task.effort = effort;
    if (agent) task.agent = agent;
    if (!running && endedAt !== undefined) task.endedAt = endedAt;
    const changes = str(result.changes);
    if (changes) task.changes = changes;
    const stoppedBy = str(result.stopped_by);
    if (stoppedBy) task.stoppedBy = stoppedBy;
    const warnings = strArray(result.warnings);
    if (warnings) task.warnings = warnings;
    const response = str(result.response);
    if (response) task.response = response.slice(0, 4000);
    const branch = str(result.branch);
    if (branch) task.branch = branch;
    if (lane === 'opencode' && lastTool) task.lastTool = lastTool;
    if (link) {
      task.sessionId = link.sessionId;
      task.nodeId = link.nodeId;
    }
    return task;
  }

  /**
   * Incrementally reads opencode.log: unchanged (mtime,size) reuses the cache, growth reads
   * only the appended range, shrink recomputes the tail. Undefined when the log cannot be read.
   */
  private async readOpencodeLogCached(dir: string): Promise<ParsedLog | undefined> {
    const path = join(dir, 'opencode.log');
    const st = await lstat(path).catch(() => undefined);
    if (!st || st.isSymbolicLink() || !st.isFile()) {
      this.logCache.delete(dir);
      return undefined;
    }
    const cached = this.logCache.get(dir);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached;
    }
    if (cached && st.size >= cached.offset) {
      // Only bytes past the cached partial tail are new.
      const readFrom = cached.offset + cached.rest.length;
      if (st.size >= readFrom) {
        const appended = await readRangeBytes(path, readFrom, st.size - readFrom);
        if (appended) {
          const buf = Buffer.concat([cached.rest, appended]);
          const { lines, rest } = extractCompleteLines(buf);
          if (lines.length > 0) {
            const parsedLog = parseOpencodeLogLines(lines);
            const toolCounts = { ...cached.toolCounts };
            for (const [tool, n] of Object.entries(parsedLog.toolCounts)) toolCounts[tool] = (toolCounts[tool] ?? 0) + n;
            const entry: LogCacheEntry = {
              ...cached,
              toolCounts,
              lastTool: parsedLog.lastTool ?? cached.lastTool,
              denied: cached.denied + parsedLog.denied,
              mtimeMs: st.mtimeMs,
              size: st.size,
              offset: readFrom + appended.length - rest.length,
              rest,
            };
            return this.saveLogCache(dir, entry);
          }
          // Nothing complete yet (partial line): just extend the rest.
          if (buf.length > cached.rest.length) {
            return this.saveLogCache(dir, { ...cached, rest: buf, mtimeMs: st.mtimeMs, size: st.size });
          }
        }
      }
    }
    // Shrunk or first read: recompute from the tail.
    const from = Math.max(0, st.size - MAX_LOG_BYTES);
    let buf = await readRangeBytes(path, from, st.size - from);
    if (buf === undefined) {
      this.logCache.delete(dir);
      return undefined;
    }
    let cutAt = from;
    if (from > 0) {
      const nl = buf.indexOf(0x0a); // drop a possibly cut first line
      if (nl >= 0) {
        cutAt += nl + 1;
        buf = buf.subarray(nl + 1);
      }
    }
    const { lines, rest } = extractCompleteLines(buf);
    // best-effort: also parse a trailing partial line (a rewritten log may end without '\n')
    if (lines.length === 0 && rest.length > 0) lines.push(rest.toString('utf8'));
    const parsed = parseOpencodeLogLines(lines.length > 0 ? lines : []);
    return this.saveLogCache(dir, {
      ...parsed,
      mtimeMs: st.mtimeMs,
      size: st.size,
      offset: cutAt + buf.length, // fully consumed (the tail spec covers the partial line)
      rest: Buffer.alloc(0),
    });
  }

  private saveLogCache(dir: string, entry: LogCacheEntry): LogCacheEntry {
    this.logCache.set(dir, entry);
    return entry;
  }

  /**
   * The worker's log, last 200 lines: opencode JSON events rendered as one readable line each,
   * agy (and any non-JSON line) passed through as raw text. Undefined for unknown or unreadable logs.
   */
  async log(lane: string, repo: string, slug: string): Promise<string[] | undefined> {
    if (lane !== 'agy' && lane !== 'opencode') return undefined;
    if (!NAME_RE.test(repo) || !NAME_RE.test(slug)) return undefined;
    const root = this.laneRoot(lane);
    let rootReal: string;
    let targetReal: string;
    try {
      rootReal = await realpath(root);
      targetReal = await realpath(join(root, repo, slug));
    } catch {
      return undefined;
    }
    // Exactly two path segments below the lane root: <repo>/<slug>; symlinks inside resolve elsewhere.
    if (!targetReal.startsWith(rootReal + sep)) return undefined;
    const target = join(rootReal, repo, slug);
    if (targetReal !== target) return undefined;
    const fileName = lane === 'agy' ? 'agy.log' : 'opencode.log';
    const logPath = join(target, fileName);
    const logSt = await lstat(logPath).catch(() => undefined);
    if (!logSt || logSt.isSymbolicLink() || !logSt.isFile()) return undefined;
    const text = await readTail(logPath, MAX_LOG_BYTES);
    if (text === undefined) return undefined;
    const lines = text.split('\n');
    if (text.length >= MAX_LOG_BYTES && lines.length > 0) lines.shift(); // drop a possibly cut first line
    const kept = lines.filter((l) => l.length > 0);
    const out: string[] = [];
    for (const line of kept) {
      if (lane === 'agy') {
        out.push(line);
        continue;
      }
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        out.push(line); // stderr noise (banner, notices) passes through
        continue;
      }
      if (e && typeof e === 'object' && !Array.isArray(e)) {
        const rendered = renderEvent(e as Record<string, unknown>);
        if (rendered) out.push(rendered);
      }
    }
    return out.slice(-200);
  }
}

/** Change-detection digest: identity plus only the fields that can move between scans. */
function signatureOf(workers: WorkerTask[]): string {
  return workers
    .map((w) => [
      w.lane,
      w.repo,
      w.slug,
      w.state,
      Math.floor(w.elapsedS / 5), // elapsed in 5 s buckets
      w.denied,
      w.lastTool ?? '',
      w.endedAt ?? -1,
    ].join(':'))
    .join('|');
}

/** Reads exactly [offset, offset+length) bytes of a file. */
async function readRangeBytes(path: string, offset: number, length: number): Promise<Buffer | undefined> {
  if (length <= 0) return Buffer.alloc(0);
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Splits a buffer into complete newline-terminated lines; the trailing partial line is not included. */
function extractCompleteLines(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(0x0a, start);
    if (nl < 0) break;
    const line = buf.subarray(start, nl).toString('utf8');
    if (line.trim().length > 0) lines.push(line);
    start = nl + 1;
  }
  return { lines, rest: buf.subarray(start) };
}

/** parseOpencodeLog over already-split lines. */
function parseOpencodeLogLines(lines: string[]): ParsedLog {
  const toolCounts: Record<string, number> = {};
  let lastTool: string | undefined;
  let denied = 0;
  const joined = lines.length > 0 ? lines.join('\n') : '';
  return joined ? { ...parseOpencodeLog(joined) } : { toolCounts, lastTool, denied };
}

/** Counts denied tool_use lines and collects toolCounts / lastTool from an opencode.log tail. */
export function parseOpencodeLog(text: string): ParsedLog {
  const toolCounts: Record<string, number> = {};
  let lastTool: string | undefined;
  let denied = 0;
  for (const line of text.split('\n')) {
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const rec = e as Record<string, unknown>;
    if (rec.type !== 'tool_use') continue;
    const part = (rec.part ?? {}) as Record<string, unknown>;
    const state = (part.state ?? {}) as Record<string, unknown>;
    const tool = str(part.tool);
    if (tool) toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
    if (state.status === 'error' && DENIED.test(String(state.error ?? ''))) denied++;
    lastTool = toolArg(part.tool, state.input);
  }
  return { toolCounts, lastTool, denied };
}
