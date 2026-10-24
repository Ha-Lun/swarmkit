// Usage limits: Claude plan-window utilisation (SDK usage probe / rate_limit_event
// messages) plus opencode and agy consumption windows. Collectors run in parallel,
// each with its own cache and timeout; one failing never fails the others, it only
// answers available:false with a short error (no paths, no secrets).
import { execFile as execFileCb } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Options, Query, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { parseObject } from './fsutil.ts';
import type { UsageLimit, UsageReport, UsageSource, UsageWindow } from '../src/shared/types.ts';

type ClaudeUsage = UsageReport['claude'];
type OpencodeUsage = UsageReport['opencode'];
type AgyUsage = UsageReport['agy'];

const execFileP = promisify(execFileCb);

/** Injectable spawn of a JSON CLI: resolves with stdout, rejects with the exec error. */
export type UsageExec = (file: string, args: string[], opts: { timeout: number }) => Promise<string>;
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
}
export function createUsageState(): UsageState {
  return { caches: new Map() };
}
const defaultState = createUsageState();

const CLAUDE_TTL_MS = 5 * 60_000;
const OPENCODE_TTL_MS = 60_000;
const AGY_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
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

/** Cache-or-compute; failures and not-available answers are never cached, so they retry. */
async function withCache<T extends UsageSource>(
  key: string,
  ttlMs: number,
  o: UsageOptions,
  compute: () => Promise<T>,
): Promise<T> {
  const state = o.state ?? defaultState;
  const now = nowMs(o);
  if (!o.refresh) {
    const entry = state.caches.get(key);
    if (entry && entry.value.available !== false && now - entry.atMs < ttlMs) return entry.value as T;
  }
  const value = await compute();
  if (value.available !== false) state.caches.set(key, { atMs: now, value });
  return value;
}

// --- claude -------------------------------------------------------------

type RateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';
const RATE_LIMIT_TYPES: RateLimitType[] = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

/** The usage endpoint answers 0-100; rate_limit_event utilization also arrives as a 0-1 fraction: normalise to 0-100. */
function utilisationOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = raw >= 0 && raw <= 1 ? raw * 100 : raw;
  return Math.round(value);
}

/** Latest-known per-window limits from the SDK's rate_limit_event messages. */
const latestLimits = new Map<RateLimitType, UsageLimit>();
let latestAtMs = 0;

/** Session fallback: built from the newest rate_limit_event of each window type. */
function claudeFromSession(): ClaudeUsage {
  if (latestLimits.size === 0) return { available: false, asOf: null };
  const out: ClaudeUsage = { available: true, asOf: new Date(latestAtMs).toISOString(), source: 'session' };
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
export function noteRateLimit(info: SDKRateLimitInfo): void {
  const type = info?.rateLimitType;
  if (!type || !(RATE_LIMIT_TYPES as string[]).includes(type)) return;
  const utilization = utilisationOf(info.utilization);
  if (utilization === null) return;
  const resetsAt =
    typeof info.resetsAt === 'number' && info.resetsAt > 0 ? new Date(info.resetsAt * 1000).toISOString() : null;
  latestLimits.set(type as RateLimitType, { utilization, resetsAt });
  latestAtMs = nowMs({});
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
}): ClaudeUsage {
  if (!res.rate_limits_available || !res.rate_limits) return claudeFromSession();
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
 * sends nothing and bills nothing. The finally unwinds the CLI process and the iterable.
 */
function neverYieldingPrompt(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    await new Promise<never>(() => {});
  }) as AsyncIterable<SDKUserMessage>;
}

/** At most one probe in flight (shared promise). */
let probeInFlight: Promise<ClaudeUsage> | undefined;

async function runProbe(o: UsageOptions): Promise<ClaudeUsage> {
  if (probeInFlight) return probeInFlight;
  const run = (async () => {
    const aborted = new AbortController();
    const prompt = neverYieldingPrompt();
    const options: Options = { cwd: os.homedir(), settingSources: [], mcpServers: {}, abortController: aborted };
    let q: Query | undefined;
    try {
      q = o.queryFactory!({ prompt, options });
      const res = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(SKIP_BEHAVIORS),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            aborted.abort();
            reject(new Error('usage probe timed out'));
          }, PROBE_TIMEOUT_MS).unref(),
        ),
      ]);
      return claudeFromProbe(res);
    } catch {
      // Unavailable or failed: the session record (or nothing) is the best answer.
      return claudeFromSession();
    } finally {
      // ALWAYS close: interrupt the query (bounded: a hanging interrupt must not stall
      // the report), end the never-yielding iterable, abort the CLI.
      await Promise.race([
        Promise.resolve(q?.interrupt?.()).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref()),
      ]);
      // Not awaited: the generator body is suspended on an await that never resolves,
      // so a pending .return() would never settle and would hang this finally.
      void (prompt as AsyncGenerator<never>).return(undefined).catch(() => {});
      aborted.abort();
    }
  })();
  probeInFlight = run.finally(() => {
    probeInFlight = undefined;
  }) as Promise<ClaudeUsage>;
  return probeInFlight;
}

async function collectClaude(o: UsageOptions): Promise<ClaudeUsage> {
  if (o.queryFactory === undefined) return claudeFromSession(); // no SDK usable here
  try {
    return await withCache('claude', CLAUDE_TTL_MS, o, () => runProbe(o));
  } catch {
    return claudeFromSession();
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
  if (o.execFile === undefined) return { available: false, asOf: null, error: 'opencode not installed' };
  try {
    return await withCache('opencode', OPENCODE_TTL_MS, o, async () => {
      const windows: UsageWindow[] = [];
      for (const days of OPENCODE_DAYS) {
        let stdout: string;
        try {
          stdout = await o.execFile('opencode', ['stats', '--days', String(days), '--json'], {
            timeout: EXEC_TIMEOUT_MS,
          });
        } catch (err) {
          if ((err as { code?: string }).code === 'ENOENT') throw new MissingBinaryError();
          throw new Error('opencode stats failed');
        }
        const data = parseObject(stdout);
        const window: UsageWindow = { days, tokens: opencodeTokens(data) };
        const cost = opencodeCost(data);
        if (cost !== undefined) window.costUsd = cost;
        windows.push(window);
      }
      return { available: true, asOf: new Date(nowMs(o)).toISOString(), windows };
    });
  } catch (err) {
    if (err instanceof MissingBinaryError) return { available: false, asOf: null, error: 'opencode not installed' };
    return { available: false, asOf: null, error: 'opencode stats failed' };
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

/** Scans <dir>/*/*/result.json (the same layout as the workers panel). Unreadable files/dirs are skipped. */
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
        st = await stat(resultPath);
      } catch {
        continue; // still running (no result yet)
      }
      if (!st.isFile()) continue;
      try {
        const data = parseObject(await readFile(resultPath, 'utf8'));
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
    return { available: false, asOf: null, error: 'agy task dir unreadable' };
  }
}

// --- assembly -----------------------------------------------------------

export async function getUsage(opts: UsageOptions = {}): Promise<UsageReport> {
  const execFile: UsageExec =
    opts.execFile ??
    ((file, args, execOpts) => execFileP(file, args, { ...execOpts, encoding: 'utf8' }).then((r) => String(r.stdout)));
  const o: UsageOptions = { ...opts, execFile };
  const unavailable = (error: string) => ({ available: false, asOf: null, error });
  const [claude, opencode, agy] = await Promise.all([
    collectClaude(o).catch(() => unavailable('usage probe failed') as ClaudeUsage),
    collectOpencode(o).catch(() => unavailable('opencode stats failed') as OpencodeUsage),
    collectAgy(o).catch(() => unavailable('agy task dir unreadable') as AgyUsage),
  ]);
  return { claude, opencode, agy };
}
