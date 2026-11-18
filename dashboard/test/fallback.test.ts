// Plan-limit fallback: lane picking, handoff prompt, limit handler, lane limits,
// and rejected rate_limit_event recording.
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKRateLimitInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  buildHandoff,
  createLimitHandler,
  pickLane,
  type HandoffSession,
  type LimitSdk,
} from '../server/fallback.ts';
import { putSecret, resetSecretStateForTests } from '../server/secrets.ts';
import { createUsageState, getLaneLimits, getUsage, noteRateLimit, type UsageExec } from '../server/usage.ts';
import type {
  ActivityEvent,
  AgentNode,
  LimitReached,
  Runtime,
  RuntimesResponse,
  UsageReport,
} from '../src/shared/types.ts';

const runtimes = (agy: boolean, opencode: boolean): RuntimesResponse => ({ claude: true, opencode, agy });

type AgyLimit = NonNullable<UsageReport['agy']['limits']>[number];
const agyLimits = (utils: (number | null)[], group = 'Gemini'): AgyLimit[] =>
  utils.map((utilization, i) => ({
    group,
    window: (i % 2 === 0 ? '5h' : 'weekly') as AgyLimit['window'],
    utilization,
    resetsAt: null,
  }));

type GoLimit = NonNullable<UsageReport['opencode']['limits']>[number];
const goLimits = (utils: (number | null)[], limited = false): GoLimit[] =>
  (['rolling', 'weekly', 'monthly'] as const).slice(0, utils.length).map((window, i) => ({
    window,
    utilization: utils[i] ?? null,
    resetsAt: null,
    limited,
  }));

const agyPart = (limits: AgyLimit[] | undefined, error?: string): UsageReport['agy'] => ({
  available: limits !== undefined,
  asOf: limits !== undefined ? '2026-01-01T00:00:00.000Z' : null,
  windows: [],
  ...(limits !== undefined ? { limits } : {}),
  ...(error !== undefined ? { error } : {}),
});

const opencodePart = (limits: GoLimit[] | undefined, limitsError?: string): UsageReport['opencode'] => ({
  available: limits !== undefined,
  asOf: limits !== undefined ? '2026-01-01T00:00:00.000Z' : null,
  windows: [],
  ...(limits !== undefined ? { limits } : {}),
  ...(limitsError !== undefined ? { limitsError } : {}),
});

describe('pickLane', () => {
  it('prefers agy when its Gemini limits are free', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([10, 20])), opencode: opencodePart(goLimits([5])) }, runtimes(true, true)),
    ).toBe('agy');
  });

  it('takes opencode when agy is at/above 95', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([96, 10])), opencode: opencodePart(goLimits([5])) }, runtimes(true, true)),
    ).toBe('opencode');
    expect(
      pickLane({ agy: agyPart(agyLimits([95])), opencode: opencodePart(goLimits([5])) }, runtimes(true, true)),
    ).toBe('opencode');
  });

  it('returns null when both lanes are full', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([99])), opencode: opencodePart(goLimits([99])) }, runtimes(true, true)),
    ).toBeNull();
    expect(
      pickLane({ agy: agyPart(agyLimits([99])), opencode: opencodePart(goLimits([10], true)) }, runtimes(true, true)),
    ).toBeNull();
  });

  it('falls through when agy has no limits', () => {
    expect(
      pickLane({ agy: agyPart(undefined, 'agy not installed'), opencode: opencodePart(goLimits([5])) }, runtimes(true, true)),
    ).toBe('opencode');
    expect(
      pickLane({ agy: agyPart(undefined, 'agy not installed'), opencode: opencodePart(undefined, 'go limits unavailable') }, runtimes(true, true)),
    ).toBeNull();
  });

  it('skips opencode on limitsError', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([10])), opencode: opencodePart(undefined, 'go limits unavailable') }, runtimes(true, true)),
    ).toBe('agy');
    expect(
      pickLane({ agy: agyPart(agyLimits([99])), opencode: opencodePart(undefined, 'go limits unavailable') }, runtimes(true, true)),
    ).toBeNull();
  });

  it('needs the lane installed', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([10])), opencode: opencodePart(goLimits([5])) }, runtimes(false, true)),
    ).toBe('opencode');
    expect(
      pickLane({ agy: agyPart(agyLimits([10])), opencode: opencodePart(goLimits([99])) }, runtimes(false, false)),
    ).toBeNull();
  });

  it('treats null utilization as unusable', () => {
    expect(
      pickLane({ agy: agyPart(agyLimits([null])), opencode: opencodePart(goLimits([5])) }, runtimes(true, true)),
    ).toBe('opencode');
    expect(
      pickLane({ agy: agyPart(agyLimits([10])), opencode: opencodePart(goLimits([null])) }, runtimes(true, true)),
    ).toBe('agy');
  });

  it('ignores non-Gemini agy groups', () => {
    expect(
      pickLane(
        { agy: agyPart([...agyLimits([99], 'Claude/GPT'), ...agyLimits([10])]), opencode: opencodePart(goLimits([5])) },
        runtimes(true, true),
      ),
    ).toBe('agy');
  });
});

function node(overrides: Partial<AgentNode> & { id: string }): AgentNode {
  return {
    sessionId: 'old',
    parentId: null,
    kind: 'main',
    agentType: 'main',
    status: 'error',
    startedAt: 1,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
    ...overrides,
  };
}

function ev(partial: Partial<ActivityEvent> & { id: string; kind: ActivityEvent['kind'] }): ActivityEvent {
  return { ts: 1, summary: '', ...partial };
}

function handoffSession(): HandoffSession {
  return {
    id: 'old',
    title: 'Old title',
    cwd: '/home/u/proj',
    nodes: [
      node({
        id: 'root',
        prompt: 'first turn prompt',
        events: [
          ev({ id: 'u1:user', ts: 2, kind: 'user', summary: 'first request', detail: 'first request' }),
          ev({ id: 't1', ts: 3, kind: 'text', summary: 'early output', detail: 'early output' }),
          ev({ id: 'u2:user', ts: 4, kind: 'user', summary: 'second request', detail: 'second request full' }),
          ev({ id: 't2', ts: 5, kind: 'text', summary: 'late output', detail: 'late output' }),
        ],
      }),
    ],
  };
}

describe('buildHandoff', () => {
  it('names the limit, title, cwd and the latest user request (not the first prompt)', () => {
    const prompt = buildHandoff(handoffSession(), { window: 'five_hour', resetsAt: '2026-11-02T00:00:00.000Z' });
    expect(prompt).toContain('plan limit');
    expect(prompt).toContain('resets');
    expect(prompt).not.toContain('unknown');
    expect(prompt).toContain('Old title');
    expect(prompt).toContain('/home/u/proj');
    expect(prompt).toContain('second request full');
    expect(prompt).not.toContain('first turn prompt');
  });

  it('falls back to root.prompt and unknown resets', () => {
    const session = handoffSession();
    session.nodes[0]!.events = session.nodes[0]!.events.filter(e => e.kind !== 'user');
    const prompt = buildHandoff(session, { window: 'seven_day', resetsAt: null });
    expect(prompt).toContain('first turn prompt');
    expect(prompt).toContain('unknown');
  });

  it('caps assistant texts at 4000 chars keeping the end', () => {
    const session = handoffSession();
    session.nodes[0]!.events = [
      ev({ id: 't1', ts: 1, kind: 'text', summary: 'start-marker-AAA', detail: 'start-marker-AAA' }),
      ev({ id: 't2', ts: 2, kind: 'text', summary: 'middle', detail: 'x'.repeat(3990) }),
      ev({ id: 't3', ts: 3, kind: 'text', summary: 'end-marker-BBB', detail: 'end-marker-BBB' }),
    ];
    const prompt = buildHandoff(session, { window: 'five_hour', resetsAt: null });
    expect(prompt).toContain('end-marker-BBB');
    expect(prompt).not.toContain('start-marker-AAA');
  });

  it('parses the latest TodoWrite todos (content + status only)', () => {
    const session = handoffSession();
    session.nodes[0]!.events.push(
      ev({
        id: 'old-todos:use', ts: 6, kind: 'tool_use', tool: 'TodoWrite', summary: 'TodoWrite',
        detail: JSON.stringify({ todos: [{ content: 'Old todo', status: 'completed' }] }),
      }),
      ev({
        id: 'new-todos:use', ts: 7, kind: 'tool_use', tool: 'TodoWrite', summary: 'TodoWrite',
        detail: JSON.stringify({
          todos: [{ content: 'Write the fallback', status: 'in_progress', priority: 'high' }],
          extra: 'should-not-appear',
        }),
      }),
    );
    const prompt = buildHandoff(session, { window: 'five_hour', resetsAt: null });
    expect(prompt).toContain('Write the fallback');
    expect(prompt).toContain('in_progress');
    expect(prompt).not.toContain('Old todo');
    expect(prompt).not.toContain('should-not-appear');
    expect(prompt).not.toContain('high');
    expect(prompt).not.toContain('priority');
  });

  it('omits todos and workers when there are none', () => {
    const prompt = buildHandoff(handoffSession(), { window: 'five_hour', resetsAt: null });
    expect(prompt).not.toContain('todos');
    expect(prompt).not.toContain('Active workers');
  });

  it('lists worker slugs still in the tree', () => {
    const session = handoffSession();
    session.nodes.push(
      node({ id: 'w1', kind: 'worker', worker: { lane: 'agy', slug: 'nightly-fix' } }),
    );
    expect(buildHandoff(session, { window: 'five_hour', resetsAt: null })).toContain('nightly-fix');
  });

  it('adds the plan-approval sentence only in plan mode', () => {
    expect(buildHandoff(handoffSession(), { window: 'five_hour', resetsAt: null })).not.toContain(
      'The plan was not approved yet',
    );
    expect(
      buildHandoff({ ...handoffSession(), permissionMode: 'plan' }, { window: 'five_hour', resetsAt: null }),
    ).toContain('The plan was not approved yet: present it and ask for approval before changing files.');
  });

  it('ends with the continue-the-task instruction', () => {
    expect(buildHandoff(handoffSession(), { window: 'five_hour', resetsAt: null })).toContain(
      'First run `git status`, `git diff` and `git log -5` in the cwd; do not redo finished steps; finish the task. In Antigravity, implementation goes to `opencode-task` workers (SWARMKIT_AGY_LEAD=1 is set); in OpenCode, to your own subagents.',
    );
  });
});

function fakeSdk(detail: (HandoffSession & {
  fallbackOf?: { sessionId: string; title: string };
  limitReached?: LimitReached;
}) | undefined, permissionMode?: string): {
  sdk: LimitSdk;
  started: Array<{ prompt: string; cwd: string; runtime: Runtime; title: string; fallbackOf: { sessionId: string; title: string } }>;
  resolved: Array<{ id: string; fallback: LimitReached['fallback'] }>;
  notified: Array<{ oldId: string; title: string; resetsAt: string | null; fallback: LimitReached['fallback'] }>;
} {
  const started: Array<{ prompt: string; cwd: string; runtime: Runtime; title: string; fallbackOf: { sessionId: string; title: string } }> = [];
  const resolved: Array<{ id: string; fallback: LimitReached['fallback'] }> = [];
  const notified: Array<{ oldId: string; title: string; resetsAt: string | null; fallback: LimitReached['fallback'] }> = [];
  const sdk: LimitSdk = {
    get: (id: string) => (id === 'old' ? detail : undefined),
    permissionModeOf: (id: string) => (id === 'old' ? permissionMode : undefined),
    start: (opts) => {
      started.push(opts);
      return 'new-id';
    },
    resolveLimit: (id, fallback) => {
      resolved.push({ id, fallback });
    },
  };
  return { sdk, started, resolved, notified };
}

const limitInfo = { window: 'five_hour', resetsAt: null as string | null };

describe('createLimitHandler', () => {
  afterEach(() => {
    delete process.env.SWARMKIT_FALLBACK;
  });

  it('starts an agy session with the old title and fallbackOf, and records the fallback', async () => {
    const { sdk, started, resolved, notified } = fakeSdk(handoffSession());
    const handler = createLimitHandler({
      sdk,
      getLaneLimits: async () => ({
        agy: agyPart(agyLimits([10])),
        opencode: opencodePart(goLimits([5])),
      }),
      runtimesStatus: () => runtimes(true, true),
      notifyLimit: (args) => {
        notified.push(args);
      },
    });
    await handler('old', limitInfo);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      cwd: '/home/u/proj',
      runtime: 'agy',
      title: 'Old title',
      fallbackOf: { sessionId: 'old', title: 'Old title' },
    });
    expect(started[0]!.prompt).toContain('Old title');
    expect(started[0]!.prompt).toContain('/home/u/proj');
    expect(resolved).toEqual([{ id: 'old', fallback: { sessionId: 'new-id', runtime: 'agy' } }]);
    expect(notified).toEqual([
      { oldId: 'old', title: 'Old title', resetsAt: null, fallback: { sessionId: 'new-id', runtime: 'agy' } },
    ]);
  });

  it('redacts stored and injected secret values from the handoff prompt', async () => {
    const config = await mkdtemp(join(tmpdir(), 'fleet-fallback-secrets-'));
    const project = await mkdtemp(join(homedir(), 'fleet-fallback-project-'));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = config;
    try {
      putSecret(project, 'API_KEY', 'sk-handoff-secret-1');
      const { sdk, started } = fakeSdk({ ...handoffSession(), title: 'Deploy with sk-handoff-secret-1' });
      const handler = createLimitHandler({
        sdk,
        getLaneLimits: async () => ({ agy: agyPart(agyLimits([10])), opencode: opencodePart(goLimits([5])) }),
        runtimesStatus: () => runtimes(true, true),
        notifyLimit: () => {},
      });
      await handler('old', limitInfo);
      expect(started[0]!.prompt).toContain('Deploy with [secret:API_KEY]');
      expect(started[0]!.prompt).not.toContain('sk-handoff-secret-1');
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      resetSecretStateForTests();
      await rm(config, { recursive: true, force: true });
      await rm(project, { recursive: true, force: true });
    }
  });

  it('uses opencode when agy is full', async () => {
    const { sdk, started, resolved } = fakeSdk(handoffSession());
    const handler = createLimitHandler({
      sdk,
      getLaneLimits: async () => ({
        agy: agyPart(agyLimits([99])),
        opencode: opencodePart(goLimits([5])),
      }),
      runtimesStatus: () => runtimes(true, true),
      notifyLimit: () => {},
    });
    await handler('old', limitInfo);
    expect(started[0]!.runtime).toBe('opencode');
    expect(resolved).toEqual([{ id: 'old', fallback: { sessionId: 'new-id', runtime: 'opencode' } }]);
  });

  it('records a null fallback when no lane is free', async () => {
    const { sdk, started, resolved, notified } = fakeSdk(handoffSession());
    const handler = createLimitHandler({
      sdk,
      getLaneLimits: async () => ({
        agy: agyPart(agyLimits([99])),
        opencode: opencodePart(goLimits([99])),
      }),
      runtimesStatus: () => runtimes(true, true),
      notifyLimit: (args) => {
        notified.push(args);
      },
    });
    await handler('old', limitInfo);
    expect(started).toHaveLength(0);
    expect(resolved).toEqual([{ id: 'old', fallback: null }]);
    expect(notified).toEqual([{ oldId: 'old', title: 'Old title', resetsAt: null, fallback: null }]);
  });

  it('SWARMKIT_FALLBACK=off starts nothing but still records a null fallback', async () => {
    process.env.SWARMKIT_FALLBACK = 'off';
    const getLaneLimits = vi.fn(async () => ({
      agy: agyPart(agyLimits([10])),
      opencode: opencodePart(goLimits([5])),
    }));
    const { sdk, started, resolved, notified } = fakeSdk(handoffSession());
    const handler = createLimitHandler({
      sdk,
      getLaneLimits,
      runtimesStatus: () => runtimes(true, true),
      notifyLimit: (args) => {
        notified.push(args);
      },
    });
    await handler('old', limitInfo);
    expect(started).toHaveLength(0);
    expect(resolved).toEqual([{ id: 'old', fallback: null }]);
    expect(notified).toEqual([{ oldId: 'old', title: 'Old title', resetsAt: null, fallback: null }]);
  });

  it('never falls back from a fallback session', async () => {
    const detail = { ...handoffSession(), fallbackOf: { sessionId: 'older', title: 'Older' } };
    const { sdk, started, resolved, notified } = fakeSdk(detail);
    const handler = createLimitHandler({
      sdk,
      getLaneLimits: async () => ({
        agy: agyPart(agyLimits([10])),
        opencode: opencodePart(goLimits([5])),
      }),
      runtimesStatus: () => runtimes(true, true),
      notifyLimit: (args) => {
        notified.push(args);
      },
    });
    await handler('old', limitInfo);
    expect(started).toHaveLength(0);
    expect(resolved).toHaveLength(0);
    expect(notified).toHaveLength(0);
  });
});

describe('lane limits', () => {
  const realXdg = process.env.XDG_DATA_HOME;
  let emptyXdg = '';

  const noProbe = () => {
    throw new Error('no probe in this test');
  };

  afterEach(async () => {
    if (realXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = realXdg;
    if (emptyXdg) await rm(emptyXdg, { recursive: true, force: true });
    emptyXdg = '';
  });

  it('returns only the limits: no claude probe, no opencode stats, no agy scan', async () => {
    emptyXdg = await mkdtemp(join(tmpdir(), 'lane-limits-xdg-'));
    process.env.XDG_DATA_HOME = emptyXdg;
    const calls: string[] = [];
    let probes = 0;
    const exec: UsageExec = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'agy') {
        return JSON.stringify({
          status: 'SUCCESS',
          command: {
            data: {
              groups: [
                {
                  name: 'Gemini Models',
                  buckets: [{ window: '5h', remaining_fraction: 0.5, reset_time: '2026-11-01T00:00:00.000Z' }],
                },
              ],
            },
          },
        });
      }
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    };
    const lanes = await getLaneLimits({
      execFile: exec,
      queryFactory: () => {
        probes += 1;
        return noProbe();
      },
      state: createUsageState(),
      taskDir: join(tmpdir(), 'no-such-lane-dir'),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.startsWith('agy '))).toBe(true);
    expect(probes).toBe(0);
    expect(lanes.agy.limits).toEqual([
      { group: 'Gemini', window: '5h', utilization: 50, resetsAt: '2026-11-01T00:00:00.000Z' },
    ]);
    // No auth.json in the empty XDG dir: Go limits are unavailable, stats never ran.
    expect(lanes.opencode.limits).toBeUndefined();
    expect(lanes.opencode.limitsError).toBe('opencode not signed in');
    expect(lanes.opencode.windows).toEqual([]);
  });
});

describe('rejected rate limits', () => {
  const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
  const unavailable = { subscription_type: null, rate_limits_available: false, rate_limits: null };

  it('records utilization 100 for rejected events (missing figure, exactly 1)', async () => {
    const state = createUsageState();
    noteRateLimit(
      { rateLimitType: 'five_hour', utilization: 1, resetsAt: FUTURE, status: 'rejected' } as unknown as SDKRateLimitInfo,
      state,
    );
    noteRateLimit(
      { rateLimitType: 'seven_day', utilization: undefined, resetsAt: FUTURE, status: 'rejected' } as unknown as SDKRateLimitInfo,
      state,
    );
    const report = await getUsage({
      execFile: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
      queryFactory: (() => ({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(unavailable),
        interrupt: async () => {},
      })) as never,
      taskDir: join(tmpdir(), 'no-such-rejected-dir'),
      state,
    });
    expect(report.claude.fiveHour).toMatchObject({ utilization: 100 });
    expect(report.claude.sevenDay).toMatchObject({ utilization: 100 });
  });

  it('keeps the old meaning without a rejected status (1 stays 1 %)', async () => {
    const state = createUsageState();
    noteRateLimit({ rateLimitType: 'five_hour', utilization: 1, resetsAt: FUTURE } as SDKRateLimitInfo, state);
    const report = await getUsage({
      execFile: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
      queryFactory: (() => ({
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => Promise.resolve(unavailable),
        interrupt: async () => {},
      })) as never,
      taskDir: join(tmpdir(), 'no-such-rejected-dir'),
      state,
    });
    expect(report.claude.fiveHour).toMatchObject({ utilization: 1 });
  });
});
