// Usage limits: Claude plan-window utilisation (SDK usage probe / rate_limit_event
// messages) plus opencode and agy consumption windows. Collectors run in parallel,
// each with its own cache and timeout; one failing never fails the others, it only
// answers available:false with a short error (no paths, no secrets).
import { execFile as execFileCb } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Options, Query, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { parseObject } from './fsutil.ts';
import type { UsageLimit, UsageReport, UsageSource, UsageWindow } from '../src/shared/types.ts';

type ClaudeUsage = UsageReport['claude'];
type OpencodeUsage = UsageReport['opencode'];
type AgyUsage = UsageReport['agy'];

const execFileP = promisify(execFileCb);

/** Injectable spawn of a JSON CLI: resolves with stdout, rejects with the exec error. */
export type UsageExec = (file: string, args: string[], opts: { timeout: number; killSignal?: NodeJS.Signals; maxBuffer?: number; cwd?: string }) => Promise<string>;
/** Injectable SDK query factory (the claude probe) so tests supply a fake query. */
export type UsageQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;
/** Injectable clock so tests can drive cache TTLs without waiting. */
export type UsageClock = () => number;

export interface UsageOptions {
  execFile?: UsageExec;
  now?: UsageClock;
  queryFactory?: UsageQueryFactory;
  /** agy task-root dir; default AGY_TASK_DIR | ~/.agy-tasks. */
  taskDir?: string;
  /** Bypass every cache (the route allows this at most once per 30 s). */
  refresh?: boolean;
  /** Fresh cache store; tests pass a new one so collectors never see other tests' values. */
  state?: UsageState;
}

export interface UsageState {
  caches: Map<string, { atMs: number; value: unknown }>;
  /** Latest-known per-window limits from rate_limit_event messages. */
  limits: Map<RateLimitType, UsageLimit>;
  limitsAtMs: number;
  /** Shared in-flight computations per collector key (single-flight). */
  inflight: Map<string, Promise<unknown>>;
  /** No new claude probe before this time (failure backoff). */
  probeBackoffUntilMs: number;
}
export function createUsageState(): UsageState {
  return { caches: new Map(), limits: new Map(), limitsAtMs: 0, inflight: new Map(), probeBackoffUntilMs: 0 };
}
const defaultState = createUsageState();

const CLAUDE_TTL_MS = 5 * 60_000;
const OPENCODE_TTL_MS = 60_000;
const AGY_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
/** Probe backoff: after rate_limits_available:false / after an error or timeout. */
const PROBE_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
const PROBE_ERROR_BACKOFF_MS = 60_000;
const OPENCODE_FAILURE_TTL_MS = 60_000;
const EXEC_MAX_BUFFER = 256 * 1024;
/** agy result.json larger than this is skipped. */
const AGY_MAX_RESULT_BYTES = 1024 * 1024;
const EXEC_TIMEOUT_MS = 5_000;
/** Cheaper than the SDK's transcript scan: the probe only wants the plan limits. */
const SKIP_BEHAVIORS = { skipBehaviors: true } as const;
/** opencode consumption windows, in days. */
const OPENCODE_DAYS = [1, 7, 30] as const;
/** agy consumption windows, in days. */
const AGY_DAYS = [1, 7] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function nowMs(o: UsageOptions): number {
  return o.now ? o.now() : Date.now();
}

/**
 * Cache-or-compute, single-flight per key (concurrent callers share one computation).
 * Failures and not-available answers are never cached, so they retry; `cacheable`
 * narrows that further.
 */
async function withCache<T extends UsageSource>(
  key: string,
  ttlMs: number,
  o: UsageOptions,
  compute: () => Promise<T>,
  cacheable: (value: T) => boolean = () => true,
): Promise<T> {
  const state = o.state ?? defaultState;
  const now = nowMs(o);
  if (!o.refresh) {
    const entry = state.caches.get(key);
    if (entry && (entry.value as UsageSource).available !== false && now - entry.atMs < ttlMs) return entry.value as T;
  }
  const pending = state.inflight.get(key);
  if (pending) return pending as Promise<T>;
  const run = (async () => {
    const value = await compute();
    if (value.available !== false && cacheable(value)) state.caches.set(key, { atMs: now, value });
    return value;
  })();
  state.inflight.set(key, run);
  try {
    return await run;
  } finally {
    if (state.inflight.get(key) === run) state.inflight.delete(key);
  }
}

// --- claude -------------------------------------------------------------

type RateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
const RATE_LIMIT_TYPES: RateLimitType[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** The usage endpoint answers 0-100 (never rescaled); clamps to 0-100. */
function utilisationOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/** rate_limit_event utilization may arrive as a 0-1 fraction: normalise to 0-100. */
function eventUtilisationOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return utilisationOf(raw >= 0 && raw <= 1 ? raw * 100 : raw);
}

/** Latest-known per-window limits from the SDK's rate_limit_event messages. */

/** Session fallback: built from the newest rate_limit_event of each window type. */
function claudeFromSession(state: UsageState): ClaudeUsage {
  const latestLimits = state.limits;
  if (latestLimits.size === 0) return { available: false, asOf: null };
  const out: ClaudeUsage = { available: true, asOf: new Date(state.limitsAtMs).toISOString(), source: 'session' };
  for (const type of RATE_LIMIT_TYPES) {
    const limit = latestLimits.get(type);
    if (!limit) continue;
    if (type === 'five_hour') out.fiveHour = limit;
    else if (type === 'seven_day') out.sevenDay = limit;
    else if (type === 'seven_day_opus') out.sevenDayOpus = limit;
    else out.sevenDaySonnet = limit;
  }
  return out;
}

/**
 * Records the latest-known plan limits from an SDK 'rate_limit_event' message so
 * /api/usage still answers between probes (and when the experimental usage call
 * is unavailable). Broader rateLimitType variants ('overage', ...) are ignored.
 */
export function noteRateLimit(info: SDKRateLimitInfo, state: UsageState = defaultState): void {
  const type = info?.rateLimitType;
  if (!type || !(RATE_LIMIT_TYPES as string[]).includes(type)) return;
  const utilization = eventUtilisationOf(info.utilization);
  if (utilization === null) return;
  const resetsAt =
    typeof info.resetsAt === 'number' && info.resetsAt > 0 ? new Date(info.resetsAt * 1000).toISOString() : null;
  state.limits.set(type as RateLimitType, { utilization, resetsAt });
  state.limitsAtMs = Date.now();
}

/** Maps the probe response to the claude block; not-available falls back to the session record. */
function claudeFromProbe(res: {
  subscription_type: string | null;
  rate_limits_available: boolean;
  rate_limits: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
    seven_day_opus?: { utilization: number | null; resets_at: string | null } | null;
    seven_day_sonnet?: { utilization: number | null; resets_at: string | null } | null;
  } | null;
}, state: UsageState): ClaudeUsage {
  if (!res.rate_limits_available || !res.rate_limits) return claudeFromSession(state);
  const as = (w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageLimit | undefined =>
    w ? { utilization: utilisationOf(w.utilization), resetsAt: w.resets_at ?? null } : undefined;
  const out: ClaudeUsage = {
    available: true,
    asOf: new Date().toISOString(),
    subscription: res.subscription_type ?? undefined,
    source: 'probe',
  };
  const fiveHour = as(res.rate_limits.five_hour);
  const sevenDay = as(res.rate_limits.seven_day);
  const sevenDayOpus = as(res.rate_limits.seven_day_opus);
  const sevenDaySonnet = as(res.rate_limits.seven_day_sonnet);
  if (fiveHour) out.fiveHour = fiveHour;
  if (sevenDay) out.sevenDay = sevenDay;
  if (sevenDayOpus) out.sevenDayOpus = sevenDayOpus;
  if (sevenDaySonnet) out.sevenDaySonnet = sevenDaySonnet;
  return out;
}

/**
 * Never yields a message: streaming-input mode keeps the queue open, so the probe
 * sends nothing and bills nothing. Finishes when the abort signal fires, so
 * `.return()` and the SDK's input loop end.
 */
function neverYieldingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  })();
}

/** At most one probe in flight (shared promise). */
let probeInFlight: Promise<ClaudeUsage> | undefined;
let probeAbort: AbortController | undefined;

/** Aborts a probe in flight (server shutdown); the CLI child is killed with it. */
export function abortUsageProbe(): void {
  probeAbort?.abort();
}

async function runProbe(o: UsageOptions): Promise<ClaudeUsage> {
  if (probeInFlight) return probeInFlight;
  const state = o.state ?? defaultState;
  const run = (async () => {
    const aborted = new AbortController();
    probeAbort = aborted;
    const prompt = neverYieldingPrompt(aborted.signal);
    const options: Options = {
      cwd: os.homedir(),
      settingSources: [],
      // No user/project/plugin MCP servers, no tools, every permission request denied.
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
      canUseTool: async () => ({ behavior: 'deny', message: 'usage probe' }),
      // The probe must leave no trace: no transcript under ~/.claude/projects.
      persistSession: false,
      abortController: aborted,
    };
    let q: Query | undefined;
    let timer: NodeJS.Timeout | undefined;
    let backoffMs = PROBE_ERROR_BACKOFF_MS;
    try {
      q = o.queryFactory!({ prompt, options });
      const res = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(SKIP_BEHAVIORS),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            aborted.abort();
            reject(new Error('usage probe timed out'));
          }, PROBE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (res.rate_limits_available && res.rate_limits) backoffMs = 0;
      else backoffMs = PROBE_UNAVAILABLE_BACKOFF_MS;
      return claudeFromProbe(res, state);
    } catch {
      // Unavailable or failed: the session record (or nothing) is the best answer.
      return claudeFromSession(state);
    } finally {
      if (timer) clearTimeout(timer);
      state.probeBackoffUntilMs = backoffMs > 0 ? nowMs(o) + backoffMs : 0;
      // ALWAYS close: interrupt the query (bounded: a hanging interrupt must not stall
      // the report), end the iterable, abort the CLI.
      let closeTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.resolve(q?.interrupt?.()).catch(() => {}),
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, 1_000);
          closeTimer.unref();
        }),
      ]);
      if (closeTimer) clearTimeout(closeTimer);
      aborted.abort();
      void (prompt as AsyncGenerator<never>).return(undefined).catch(() => {});
      if (probeAbort === aborted) probeAbort = undefined;
    }
  })();
  probeInFlight = run.finally(() => {
    probeInFlight = undefined;
  }) as Promise<ClaudeUsage>;
  return probeInFlight;
}

async function collectClaude(o: UsageOptions): Promise<ClaudeUsage> {
  const state = o.state ?? defaultState;
  if (o.queryFactory === undefined) return claudeFromSession(state); // no SDK usable here
  try {
    const entry = state.caches.get('claude');
    const cached = entry && !o.refresh && nowMs(o) - entry.atMs < CLAUDE_TTL_MS;
    // Inside the failure backoff: the session record answers, no new probe (refresh may skip it).
    if (!cached && !o.refresh && nowMs(o) < state.probeBackoffUntilMs) return claudeFromSession(state);
    // Only real probe answers are cached; session fallbacks follow the probe backoff instead.
    return await withCache('claude', CLAUDE_TTL_MS, o, () => runProbe(o), (v) => v.source === 'probe');
  } catch {
    return claudeFromSession(state);
  }
}

// --- opencode -----------------------------------------------------------

class MissingBinaryError extends Error {}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function fieldOf(data: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const v = data[name];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Token bucket tolerating the documented `tokens:{input,output,reasoning,cache:{read,write}}` shape and snake_case cache keys. */
function opencodeTokens(data: Record<string, unknown>): number {
  const bucket = data.tokens;
  const src: Record<string, unknown> =
    bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? (bucket as Record<string, unknown>) : data;
  const cache = src.cache;
  const cacheObj: Record<string, unknown> =
    cache && typeof cache === 'object' && !Array.isArray(cache) ? (cache as Record<string, unknown>) : {};
  return (
    num(fieldOf(src, 'input')) +
    num(fieldOf(src, 'output')) +
    num(fieldOf(src, 'reasoning')) +
    num(fieldOf(cacheObj, 'read', 'cache_read', 'cacheRead')) +
    num(fieldOf(cacheObj, 'write', 'cache_write', 'cacheWrite'))
  );
}

/** USD spend of one stats answer (estimate); undefined when the CLI gave no cost figure. */
function opencodeCost(data: Record<string, unknown>): number | undefined {
  const cost = data.cost;
  if (typeof cost === 'number' && Number.isFinite(cost)) return cost;
  const nested =
    cost && typeof cost === 'object' && !Array.isArray(cost)
      ? fieldOf(cost as Record<string, unknown>, 'total', 'total_usd', 'usd')
      : undefined;
  return nested ?? fieldOf(data, 'costUsd', 'cost_usd', 'total_cost_usd');
}

async function collectOpencode(o: UsageOptions): Promise<OpencodeUsage> {
  const execFile = o.execFile;
  if (execFile === undefined) return { available: false, asOf: null, error: 'opencode not installed', windows: [] };
  const state = o.state ?? defaultState;
  const failed = state.caches.get('opencode:failed');
  if (!o.refresh && failed && nowMs(o) - failed.atMs < OPENCODE_FAILURE_TTL_MS) return failed.value as OpencodeUsage;
  try {
    return await withCache('opencode', OPENCODE_TTL_MS, o, async () => {
      const windows: UsageWindow[] = [];
      for (const days of OPENCODE_DAYS) {
        let stdout: string;
        let timer: NodeJS.Timeout | undefined;
        try {
          stdout = await Promise.race([
            execFile('opencode', ['stats', '--days', String(days), '--json'], {
              timeout: EXEC_TIMEOUT_MS,
              killSignal: 'SIGKILL',
              maxBuffer: EXEC_MAX_BUFFER,
              cwd: os.homedir(),
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('opencode stats timed out')), EXEC_TIMEOUT_MS + 1_000);
              timer.unref();
            }),
          ]);
        } catch (err) {
          if ((err as { code?: string }).code === 'ENOENT') throw new MissingBinaryError();
          throw new Error('opencode stats failed');
        } finally {
          if (timer) clearTimeout(timer);
        }
        const data = parseObject(stdout);
        const window: UsageWindow = { days, tokens: opencodeTokens(data) };
        const cost = opencodeCost(data);
        if (cost !== undefined) window.costUsd = cost;
        windows.push(window);
      }
      state.caches.delete('opencode:failed');
      return { available: true, asOf: new Date(nowMs(o)).toISOString(), windows };
    });
  } catch (err) {
    if (err instanceof MissingBinaryError) return { available: false, asOf: null, error: 'opencode not installed', windows: [] };
    const value: OpencodeUsage = { available: false, asOf: null, error: 'opencode stats failed', windows: [] };
    // Non-ENOENT failures are remembered briefly so a broken CLI is not respawned on every poll.
    state.caches.set('opencode:failed', { atMs: nowMs(o), value });
    return value;
  }
}

// --- agy ----------------------------------------------------------------

interface AgyRun {
  mtimeMs: number;
  tokens: number;
  stopped: boolean;
}

/** `usage` of one result.json: input + output + reasoning + cache_read. */
function agyTokens(data: Record<string, unknown>): number {
  const usage = data.usage;
  const src: Record<string, unknown> =
    usage && typeof usage === 'object' && !Array.isArray(usage) ? (usage as Record<string, unknown>) : {};
  return num(src.input) + num(src.output) + num(src.reasoning) + num(src.cache_read);
}

/** Opens without following symlinks or blocking, re-checks the handle, reads at most the cap. */
async function readBounded(path: string): Promise<string> {
  const fh = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > AGY_MAX_RESULT_BYTES) throw new Error('result.json skipped');
    const buf = Buffer.alloc(Math.min(st.size, AGY_MAX_RESULT_BYTES));
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await fh.read(buf, off, buf.length - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.toString('utf8', 0, off);
  } finally {
    await fh.close();
  }
}

/** Scans the result.json of every finished task: the same three-level layout as the workers panel. */
async function agyRuns(dir: string): Promise<AgyRun[]> {
  const repos = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const runs: AgyRun[] = [];
  for (const repo of repos) {
    let tasks: string[];
    try {
      tasks = (await readdir(join(dir, repo), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue; // unreadable repo dir: skip it, scan the rest
    }
    for (const slug of tasks) {
      const resultPath = join(dir, repo, slug, 'result.json');
      let st;
      try {
        st = await lstat(resultPath);
      } catch {
        continue; // still running (no result yet)
      }
      // Regular files only (no symlinks, FIFOs, devices) and bounded in size.
      if (!st.isFile() || st.size > AGY_MAX_RESULT_BYTES) continue;
      try {
        const data = parseObject(await readBounded(resultPath));
        runs.push({
          mtimeMs: st.mtimeMs,
          tokens: agyTokens(data),
          stopped: data.stopped_by !== undefined || data.ok === false,
        });
      } catch {
        continue; // an unreadable result.json must not fail the whole window
      }
    }
  }
  return runs;
}

function agyWindows(runs: AgyRun[], now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const days of AGY_DAYS) {
    const inWindow = runs.filter((r) => now - r.mtimeMs <= days * DAY_MS);
    windows.push({
      days,
      tokens: inWindow.reduce((sum, r) => sum + r.tokens, 0),
      runs: inWindow.length,
      stopped: inWindow.filter((r) => r.stopped).length,
    });
  }
  return windows;
}

async function collectAgy(o: UsageOptions): Promise<AgyUsage> {
  try {
    return await withCache('agy', AGY_TTL_MS, o, async () => {
      const dir = o.taskDir ?? process.env.AGY_TASK_DIR ?? join(os.homedir(), '.agy-tasks');
      const runs = await agyRuns(dir);
      return { available: true, asOf: new Date(nowMs(o)).toISOString(), windows: agyWindows(runs, nowMs(o)) };
    });
  } catch {
    return { available: false, asOf: null, error: 'agy task dir unreadable', windows: [] };
  }
}

// --- assembly -----------------------------------------------------------

export async function getUsage(opts: UsageOptions = {}): Promise<UsageReport> {
  const execFile: UsageExec =
    opts.execFile ??
    ((file, args, execOpts) => execFileP(file, args, { ...execOpts, killSignal: 'SIGKILL', maxBuffer: EXEC_MAX_BUFFER, cwd: os.homedir(), encoding: 'utf8' }).then((r) => String(r.stdout)));
  const o: UsageOptions = {
    ...opts,
    execFile,
    // Production default: the SDK's own query factory (tests inject a fake).
    queryFactory: opts.queryFactory ?? ((args) => query(args)),
  };
  const unavailable = (error: string) => ({ available: false, asOf: null, error });
  const noWindows = (error: string) => ({ ...unavailable(error), windows: [] });
  const [claude, opencode, agy] = await Promise.all([
    collectClaude(o).catch(() => unavailable('usage probe failed') as ClaudeUsage),
    collectOpencode(o).catch(() => noWindows('opencode stats failed') as OpencodeUsage),
    collectAgy(o).catch(() => noWindows('agy task dir unreadable') as AgyUsage),
  ]);
  return { claude, opencode, agy };
}
