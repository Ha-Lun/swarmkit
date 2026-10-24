// Usage collectors: opencode stats parsing, fallback paths, agy result.json windows,
// cache TTLs with a fake clock and the claude probe mapping (including its finally).
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKRateLimitInfo, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  UsageExec,
  UsageQueryFactory,
  UsageOptions,
} from '../server/usage.ts';
import { createUsageState, getUsage, noteRateLimit } from '../server/usage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Collectors that don't care about claude inject this instead of the SDK default,
 * so no real probe process is ever spawned in tests.
 */
const noProbeFactory: UsageQueryFactory = () => {
  throw new Error('no probe in this test');
};

interface QueryRecord {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
  usages: Array<Promise<unknown>>;
  interrupts: number;
}

function fakeQuery(
  usage: (q: QueryRecord) => Promise<unknown>,
): { factory: UsageQueryFactory; queries: QueryRecord[] } {
  const queries: QueryRecord[] = [];
  const factory: UsageQueryFactory = ({ prompt, options }) => {
    const record: QueryRecord = { prompt, options, usages: [], interrupts: 0 };
    queries.push(record);
    const q = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (opts: unknown) => {
        void opts;
        const p = usage(record);
        record.usages.push(p);
        return p;
      },
      interrupt: async () => {
        record.interrupts += 1;
      },
    } as unknown as Query;
    return q;
  };
  return { factory, queries };
}

function clockOf(o: UsageOptions): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** exec counting calls, returning a canned stdout for `opencode stats --days N --json`. */
function fakeStats(responses: Record<string, string>): { exec: UsageExec; calls: string[] } {
  const calls: string[] = [];
  const exec: UsageExec = async (file, args, execOpts) => {
    void execOpts;
    calls.push(`${file} ${args.join(' ')}`);
    if (file !== 'opencode') throw Object.assign(new Error(`not opencode: ${file}`), { code: 'ENOENT' });
    const daysIdx = args.indexOf('--days');
    const days = daysIdx >= 0 ? args[daysIdx + 1] : args[0];
    const body = responses[days ?? ''];
    if (body === undefined) throw new Error(`no canned stats for days=${days}`);
    return body;
  };
  return { exec, calls };
}

describe('opencode collector', () => {
  it('parses tokens (input+output+reasoning+cache read/write) and cost per window', async () => {
    const responses: Record<string, string> = {
      '1': JSON.stringify({ tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 40, write: 5 } }, cost: 0.12 }),
      '7': JSON.stringify({ tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 400, write: 50 } }, cost: 1.2 }),
      '30': JSON.stringify({ tokens: { input: 1, output: 2 }, cost: 0.01 }),
    };
    const { exec, calls } = fakeStats(responses);
    const report = await getUsage({ execFile: exec, queryFactory: noProbeFactory, state: createUsageState() });
    expect(report.opencode.available).toBe(true);
    expect(report.opencode.windows).toHaveLength(3);
    expect(report.opencode.windows.map((w) => w.days)).toEqual([1, 7, 30]);
    expect(report.opencode.windows[0]).toEqual({ days: 1, tokens: 78, costUsd: 0.12 });
    expect(report.opencode.windows[1]!.tokens).toBe(780);
    expect(report.opencode.windows[2]!.tokens).toBe(3);
    // execFile, never a shell: exactly three direct invocations
    expect(calls.filter((c) => c.includes('--days 1')).every((c) => c === 'opencode stats --days 1 --json')).toBe(true);
  });

  it('answers available:false with a reason when the binary is missing', async () => {
    const exec: UsageExec = async () => {
      throw Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
    };
    const report = await getUsage({ execFile: exec, queryFactory: noProbeFactory, state: createUsageState() });
    expect(report.opencode).toMatchObject({ available: false, asOf: null, error: 'opencode not installed' });
  });

  it('a failing opencode collector does not fail the others', async () => {
    const exec: UsageExec = async () => {
      throw new Error('stats exploded');
    };
    const agyDir = await mkdtemp(join(tmpdir(), 'usage-empty-'));
    try {
      const report = await getUsage({ execFile: exec, queryFactory: noProbeFactory, taskDir: agyDir, state: createUsageState() });
      expect(report.opencode.available).toBe(false);
      expect(report.opencode.error).toBe('opencode stats failed');
      expect(report.agy).toBeDefined();
      expect(report.claude).toBeDefined();
    } finally {
      await rm(agyDir, { recursive: true, force: true });
    }
  });
});

describe('agy collector', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'usage-agy-'));
    await mkdir(join(dir, 'repo-a', 'fresh-ok'), { recursive: true });
    await mkdir(join(dir, 'repo-a', 'fresh-stop'), { recursive: true });
    await mkdir(join(dir, 'repo-b', 'stale-ok'), { recursive: true });
    await writeFile(join(dir, 'repo-a', 'fresh-ok', 'result.json'), JSON.stringify({
      ok: true,
      usage: { input: 10, output: 5, reasoning: 2, cache_read: 8 },
    }));
    await writeFile(join(dir, 'repo-a', 'fresh-stop', 'result.json'), JSON.stringify({
      ok: false,
      stopped_by: 'timeout',
      usage: { input: 1, output: 0, cache_read: 1 },
    }));
    await writeFile(join(dir, 'repo-b', 'stale-ok', 'result.json'), JSON.stringify({
      ok: true,
      usage: { input: 900, output: 400, reasoning: 100, cache_read: 600 },
    }));
    // 8 days ago: outside both windows
    const ago = new Date(Date.now() - 8 * DAY_MS);
    await utimes(join(dir, 'repo-b', 'stale-ok', 'result.json'), ago, ago);
    // a still-running task (no result.json yet) is simply absent
    await mkdir(join(dir, 'repo-a', 'running'), { recursive: true });
    await writeFile(join(dir, 'repo-a', 'running', 'pid'), '1234');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('aggregates tokens/runs/stopped per window by result.json mtime', async () => {
    const report = await getUsage({ queryFactory: noProbeFactory, taskDir: dir, state: createUsageState() });
    expect(report.agy.available).toBe(true);
    expect(report.agy.windows).toHaveLength(2);
    const [day1, day7] = report.agy.windows;
    // fresh-ok=25 tokens, fresh-stop=2 tokens; stale (8 d) is outside both windows.
    expect(day1).toEqual({ days: 1, tokens: 27, runs: 2, stopped: 1 });
    expect(day7).toEqual({ days: 7, tokens: 27, runs: 2, stopped: 1 });
  });

  it('answers available:false when the task dir is missing', async () => {
    const report = await getUsage({ queryFactory: noProbeFactory, taskDir: join(dir, 'no-such-dir'), state: createUsageState() });
    expect(report.agy).toMatchObject({ available: false, asOf: null, error: 'agy task dir unreadable' });
  });
});

describe('cache TTL', () => {
  it('reuses collector values within their TTL and recomputes after it', async () => {
    const responses: Record<string, string> = {
      '1': JSON.stringify({ tokens: { input: 3 } }),
      '7': JSON.stringify({ tokens: { input: 3 } }),
      '30': JSON.stringify({ tokens: { input: 3 } }),
    };
    let stats = fakeStats(responses);
    const clock = clockOf({});
    const state = createUsageState();
    const agyDir = await mkdtemp(join(tmpdir(), 'usage-empty-'));
    const base = (): UsageOptions => ({ execFile: stats.exec, queryFactory: noProbeFactory, now: clock.now, taskDir: agyDir, state });
    try {
      await getUsage(base()); // prime: opencode + agy computed, claude from session (no factory)
      expect(stats.calls.length).toBe(3);

      clock.advance(30_000);
      const warm = await getUsage(base());
      expect(stats.calls.length).toBe(3); // exec never invoked again: all within TTL
      expect(warm.opencode.windows[0]!.tokens).toBe(3);

      clock.advance(61_000); // opencode/agy caches (60 s) expire
      const after = fakeStats(responses);
      stats = after;
      const cold = await getUsage(base());
      expect(after.calls.length).toBe(3);
      expect(cold.opencode.available).toBe(true);
    } finally {
      await rm(agyDir, { recursive: true, force: true });
    }
  });

  it('refresh:1 bypasses the caches', async () => {
    const responses: Record<string, string> = {
      '1': JSON.stringify({ tokens: { input: 2 } }),
      '7': JSON.stringify({ tokens: { input: 2 } }),
      '30': JSON.stringify({ tokens: { input: 2 } }),
    };
    const { exec, calls } = fakeStats(responses);
    const state = createUsageState();
    const agyDir = await mkdtemp(join(tmpdir(), 'usage-empty-'));
    try {
      await getUsage({ execFile: exec, queryFactory: noProbeFactory, taskDir: agyDir, state });
      expect(calls.length).toBe(3);
      await getUsage({ execFile: exec, queryFactory: noProbeFactory, taskDir: agyDir, state, refresh: true });
      expect(calls.length).toBe(6); // all windows recomputed despite the fresh TTL
    } finally {
      await rm(agyDir, { recursive: true, force: true });
    }
  });
});

describe('claude probe', () => {
  const probeResponse = {
    session: {},
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42, resets_at: '2026-01-01T00:00:00.000Z' },
      seven_day: null,
      seven_day_opus: { utilization: 11, resets_at: null },
    },
  };

  it('maps the usage response and always closes the query', async () => {
    const { factory, queries } = fakeQuery(() => Promise.resolve(probeResponse));
    const report = await getUsage({ queryFactory: factory, state: createUsageState() });
    expect(report.claude).toMatchObject({
      available: true,
      source: 'probe',
      subscription: 'max',
      fiveHour: { utilization: 42, resetsAt: '2026-01-01T00:00:00.000Z' },
      sevenDayOpus: { utilization: 11, resetsAt: null },
    });
    expect(report.claude.sevenDay).toBeUndefined();
    expect(report.claude.sevenDaySonnet).toBeUndefined();

    const [q] = queries;
    expect(q.options.settingSources).toEqual([]);
    expect(q.options.mcpServers).toEqual({});
    expect(q.options.cwd).toBe(os.homedir());
    // The probe leaves no trace: no transcript under ~/.claude/projects.
    expect(q.options.persistSession).toBe(false);
    // Streaming-input mode: a real async-iterable prompt (generator instance, not a function).
    expect(q.prompt[Symbol.asyncIterator]).toBeTypeOf('function');
    expect((q.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next).toBeTypeOf('function');
    expect(q.interrupts).toBe(1); // closed in finally
  });

  it('rate_limits_available:false falls back to the latest rate_limit_event record', async () => {
    const state = createUsageState();
    noteRateLimit({
      rateLimitType: 'five_hour',
      utilization: 0.43, // 0-1 fraction: normalised to 43
      resetsAt: 1_767_225_600,
    } as SDKRateLimitInfo, state);
    const { factory, queries } = fakeQuery(() =>
      Promise.resolve({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
    );
    const report = await getUsage({ queryFactory: factory, state });
    expect(report.claude).toMatchObject({
      available: true,
      source: 'session',
      fiveHour: { utilization: 43, resetsAt: new Date(1_767_225_600 * 1000).toISOString() },
    });
    expect(queries[0]!.interrupts).toBe(1);
  });

  it('a throwing probe never fails the report and still closes the query', async () => {
    const state = createUsageState();
    noteRateLimit({
      rateLimitType: 'seven_day',
      utilization: 180, // out of range: clamped to 100
      resetsAt: undefined,
    } as SDKRateLimitInfo, state);
    const { factory, queries } = fakeQuery(() => Promise.reject(new Error('usage endpoint down')));
    const report = await getUsage({ queryFactory: factory, state });
    expect(report.claude).toMatchObject({ available: true, source: 'session' });
    expect(report.claude.fiveHour).toBeUndefined();
    expect(report.claude.sevenDay).toMatchObject({ utilization: 100, resetsAt: null });
    expect(queries[0]!.interrupts).toBe(1);
    expect(report.opencode).toBeDefined();
    expect(report.agy).toBeDefined();
  });

  it('no rate_limit_event record at all: a failed probe answers available:false, unknown types are ignored', async () => {
    const state = createUsageState();
    noteRateLimit({ rateLimitType: 'overage', utilization: 99 } as SDKRateLimitInfo, state); // must be ignored
    const { factory } = fakeQuery(() => Promise.reject(new Error('down')));
    const report = await getUsage({ queryFactory: factory, state });
    expect(report.claude.available).toBe(false);
  });
});

describe('noteRateLimit', () => {
  it('overwrites the per-window record and ignores unknown types and non-numeric utilisation', async () => {
    const state = createUsageState();
    noteRateLimit({ rateLimitType: 'seven_day_sonnet', utilization: 200, resetsAt: 0 } as SDKRateLimitInfo, state);
    noteRateLimit({ rateLimitType: 'overage', utilization: 99 } as SDKRateLimitInfo, state); // unknown window: ignored
    noteRateLimit({ rateLimitType: 'five_hour', utilization: undefined, resetsAt: 100 } as SDKRateLimitInfo, state); // ignored
    noteRateLimit({ rateLimitType: 'five_hour', utilization: 64, resetsAt: 1_900_000_000 } as SDKRateLimitInfo, state);
    const { factory } = fakeQuery(() =>
      Promise.resolve({ subscription_type: null, rate_limits_available: false, rate_limits: null }),
    );
    const report = await getUsage({ queryFactory: factory, state });
    expect(report.claude.source).toBe('session');
    expect(report.claude.sevenDaySonnet).toEqual({ utilization: 100, resetsAt: null });
    expect(report.claude.fiveHour).toEqual({ utilization: 64, resetsAt: new Date(1_900_000_000 * 1000).toISOString() });
  });
});
