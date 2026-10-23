// Workers registry: scans agy-task / opencode-task task dirs (<root>/<repo>/<slug>/) and
// reports their live state, mirroring scripts/agy-task (see alive(), list_extra(), tool_failure()).
import { open, readdir, readFile, stat } from 'node:fs/promises';
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
  private lastJson = '';

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
      const json = JSON.stringify(workers);
      if (json !== this.lastJson) {
        this.lastJson = json;
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
      const text = await readTail(join(dir, 'opencode.log'), MAX_LOG_BYTES);
      if (text) {
        const parsed = parseOpencodeLog(text);
        denied = parsed.denied;
        toolCounts = parsed.toolCounts;
        lastTool = parsed.lastTool;
      }
    } else if (!running && resultText !== undefined) {
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
   * The worker's log, last 200 lines: opencode JSON events rendered as one readable line each,
   * agy (and any non-JSON line) passed through as raw text. Undefined for unknown or unreadable logs.
   */
  async log(lane: string, repo: string, slug: string): Promise<string[] | undefined> {
    if (lane !== 'agy' && lane !== 'opencode') return undefined;
    if (!NAME_RE.test(repo) || !NAME_RE.test(slug)) return undefined;
    const root = this.laneRoot(lane);
    let rootReal: string;
    let target: string;
    try {
      rootReal = await realpath(root);
      target = await realpath(join(root, repo, slug));
    } catch {
      return undefined;
    }
    if (target !== rootReal && !target.startsWith(rootReal + sep)) return undefined;
    const fileName = lane === 'agy' ? 'agy.log' : 'opencode.log';
    const text = await readTail(join(target, fileName), MAX_LOG_BYTES);
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
