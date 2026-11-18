// Plan-limit detection in the SDK consume loop: rejected rate_limit_event and
// matching assistant rate_limit errors call onLimit once, pin the root to error
// (never "done") and close the queue. Overloads, 429s without the limit text,
// stopped sessions, fallback sessions and non-Claude runtimes never call it.
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import { CAP_FLOOR_MS, EVICT_AFTER_MS, MAX_PAGE_SESSIONS, SdkSessions } from '../server/sdk/sessions';
import type { QueryFn } from '../server/sdk/sessions';
import { TranscriptWatcher } from '../server/watch/transcripts';

// Same minimal tree fake as sessions.test.ts: applyMessage is a no-op, setStatus
// pins the status. The limit path sets error explicitly, so it works with the fake too.
vi.mock('../server/model/reducer.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/model/reducer.ts')>();
  const makeRoot = (sessionId: string, init: TreeInit = { startedAt: Date.now() }): AgentNode => ({
    id: 'root',
    sessionId,
    parentId: null,
    kind: 'main',
    agentType: init.agentType ?? 'main',
    ...(init.prompt ? { prompt: init.prompt } : {}),
    status: 'running',
    startedAt: init.startedAt ?? Date.now(),
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
  });
  return {
    ...actual,
    createTree(sessionId: string, init?: TreeInit): SessionTree {
      return {
        sessionId,
        nodes: new Map([['root', makeRoot(sessionId, init)]]),
        toolOwner: new Map(),
      };
    },
    applyMessage(): ServerEvent[] {
      return [];
    },
    setStatus(tree: SessionTree, nodeId: string, status: AgentNode['status']): ServerEvent[] {
      const node = tree.nodes.get(nodeId);
      if (node) node.status = status;
      const { events: _events, ...head } = node ?? ({} as AgentNode);
      const nodeHead = head as AgentNodeHead;
      return [{ type: 'node.upsert', node: nodeHead }];
    },
  };
});

const homeDir = mkdtempSync(path.join(homedir(), 'fleet-limit-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

const RESET_S = 1_800_000_000;
const RESET_ISO = new Date(RESET_S * 1000).toISOString();

interface LimitStreamOptions {
  event?: { status?: string; rateLimitType?: string; utilization?: number; resetsAt?: number };
  assistantError?: string;
  assistantText?: string;
  gate?: Promise<void>;
}

/** Fake query: init, optional limit signals, then an is_error result. */
function limitQuery(opts: LimitStreamOptions): QueryFn {
  return () =>
    (async function* generator(): AsyncGenerator<unknown, void> {
      yield { type: 'system', subtype: 'init', model: 'test' };
      if (opts.event) yield { type: 'rate_limit_event', rate_limit_info: { ...opts.event } };
      if (opts.assistantError !== undefined) {
        yield {
          type: 'assistant',
          error: opts.assistantError,
          message: { content: [{ type: 'text', text: opts.assistantText ?? '' }] },
        };
      }
      if (opts.gate) await opts.gate;
      yield { type: 'result', subtype: 'error', is_error: true };
    })() as unknown as AsyncIterable<SDKMessage>;
}

interface RawSession {
  consuming: boolean;
  stopped: boolean;
  updatedAt: number;
  queue: { closed: boolean };
}

function raw(sdk: SdkSessions, id: string): RawSession {
  const map = (sdk as unknown as { sessions: Map<string, RawSession> }).sessions;
  const session = map.get(id);
  expect(session).toBeDefined();
  return session!;
}

describe('plan-limit detection', () => {
  it('rejected event + matching assistant error calls onLimit once, keeps error, closes the queue', async () => {
    const events: ServerEvent[] = [];
    const onLimit = vi.fn();
    const sdk = new SdkSessions(e => events.push(e), limitQuery({
      event: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: RESET_S },
      assistantError: 'rate_limit',
      assistantText: 'Claude usage limit reached, try again later',
    }), undefined, { onLimit });
    const id = sdk.start({ prompt: 'do work', cwd: homeDir });
    await vi.waitFor(() => {
      expect(onLimit).toHaveBeenCalledTimes(1);
    });
    expect(onLimit).toHaveBeenCalledWith(id, { window: 'five_hour', resetsAt: RESET_ISO });
    await vi.waitFor(() => {
      expect(raw(sdk, id).consuming).toBe(false);
    });
    expect(sdk.get(id)?.status).toBe('error');
    expect(raw(sdk, id).queue.closed).toBe(true);
    expect(sdk.get(id)?.limitReached).toMatchObject({ window: 'five_hour', fallback: null });
    // No spurious "done" afterwards.
    expect(sdk.get(id)?.status).not.toBe('done');
  });

  it('continuing the session (resume/restart unwind) clears the limit so the next turn can finish', async () => {
    const onLimit = vi.fn();
    const sdk = new SdkSessions(() => {}, limitQuery({
      event: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: RESET_S },
    }), undefined, { onLimit });
    const id = sdk.start({ prompt: 'do work', cwd: homeDir });
    await vi.waitFor(() => expect(raw(sdk, id).consuming).toBe(false));
    expect(sdk.get(id)?.limitReached).toBeDefined();
    const session = raw(sdk, id) as unknown as { limitHit?: unknown; limitNotified?: boolean };
    await (sdk as unknown as { unwind(s: unknown): Promise<void> }).unwind(session);
    expect(session.limitHit).toBeUndefined();
    expect(session.limitNotified).toBe(true);
    expect(sdk.get(id)?.limitReached).toBeUndefined();
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it('assistant error alone counts (five_hour, no resetsAt); overage events count too', async () => {
    const assistantOnly = vi.fn();
    const sdk = new SdkSessions(() => {}, limitQuery({
      assistantError: 'rate_limit',
      assistantText: 'You have hit your usage limit for now',
    }), undefined, { onLimit: assistantOnly });
    const id = sdk.start({ prompt: 'help me', cwd: homeDir });
    await vi.waitFor(() => {
      expect(assistantOnly).toHaveBeenCalledTimes(1);
    });
    expect(assistantOnly).toHaveBeenCalledWith(id, { window: 'five_hour', resetsAt: null });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('error');
    });

    const overage = vi.fn();
    const sdk2 = new SdkSessions(() => {}, limitQuery({
      event: { status: 'rejected', rateLimitType: 'overage', utilization: 1, resetsAt: RESET_S },
    }), undefined, { onLimit: overage });
    const id2 = sdk2.start({ prompt: 'overage work', cwd: homeDir, runtime: 'claude' });
    await vi.waitFor(() => {
      expect(overage).toHaveBeenCalledTimes(1);
    });
    expect(overage).toHaveBeenCalledWith(id2, { window: 'overage', resetsAt: RESET_ISO });
  });

  it('a plain 429 / overload without the limit text does not count', async () => {
    for (const stream of [
      // rate_limit error but no plan-limit wording.
      limitQuery({ assistantError: 'rate_limit', assistantText: 'Request failed with 429, retrying' }),
      // overloaded error even with plan-limit wording.
      limitQuery({ assistantError: 'overloaded', assistantText: 'Usage limit reached' }),
    ]) {
      const onLimit = vi.fn();
      const sdk = new SdkSessions(() => {}, stream, undefined, { onLimit });
      const id = sdk.start({ prompt: 'plain failure', cwd: homeDir });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(onLimit).not.toHaveBeenCalled();
      expect(sdk.get(id)?.limitReached).toBeUndefined();
    }
  });

  it('a stopped session never calls onLimit', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const onLimit = vi.fn();
    const sdk = new SdkSessions(() => {}, limitQuery({
      event: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: RESET_S },
      gate,
    }), undefined, { onLimit });
    const id = sdk.start({ prompt: 'stoppable', cwd: homeDir });
    await vi.waitFor(() => {
      expect(raw(sdk, id).consuming).toBe(true);
    });
    expect(sdk.stop(id)).toBe(true);
    release();
    await vi.waitFor(() => {
      expect(raw(sdk, id).consuming).toBe(false);
    });
    expect(onLimit).not.toHaveBeenCalled();
    expect(sdk.get(id)?.status).toBe('stopped');
  });

  it('a session with fallbackOf never calls onLimit', async () => {
    const onLimit = vi.fn();
    const sdk = new SdkSessions(() => {}, limitQuery({
      event: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: RESET_S },
      assistantError: 'rate_limit',
      assistantText: 'usage limit reached',
    }), undefined, { onLimit });
    const id = sdk.start({ prompt: 'fallback lead', cwd: homeDir, fallbackOf: { sessionId: 'old', title: 'Old' } });
    await vi.waitFor(() => {
      expect(raw(sdk, id).consuming).toBe(false);
    });
    expect(onLimit).not.toHaveBeenCalled();
    expect(sdk.get(id)?.fallbackOf).toEqual({ sessionId: 'old', title: 'Old' });
    expect(sdk.get(id)?.limitReached).toBeUndefined();
  });

  it('a non-Claude runtime never calls onLimit', async () => {
    const onLimit = vi.fn();
    const stream = limitQuery({
      event: { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: RESET_S },
      assistantError: 'rate_limit',
      assistantText: 'usage limit reached',
    });
    const sdk = new SdkSessions(() => {}, undefined, { acp: () => stream }, { onLimit });
    const id = sdk.start({ prompt: 'opencode lead', cwd: homeDir, runtime: 'opencode' });
    await vi.waitFor(() => {
      expect(raw(sdk, id).consuming).toBe(false);
    });
    expect(onLimit).not.toHaveBeenCalled();
    expect(sdk.get(id)?.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// retention: an evicted page session whose transcript is on disk must not vanish
// ---------------------------------------------------------------------------

/** Fake query: the first `hold` streams stay open (running), the rest finish at once. */
function mixedQuery(hold: number): QueryFn {
  const gate = new Promise<void>(() => {});
  let calls = 0;
  return () => {
    const held = calls++ < hold;
    return (async function* generator(): AsyncGenerator<unknown, void> {
      yield { type: 'system', subtype: 'init', model: 'test' };
      if (held) await gate;
      yield { type: 'result', subtype: 'success' };
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

function transcriptLines(cwd: string): string {
  const user = JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2025-01-01T10:00:00.000Z',
    cwd,
    message: { role: 'user', content: 'Evicted but still here' },
  });
  const assistant = JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2025-01-01T10:00:05.000Z',
    message: {
      id: 'm1',
      model: 'claude-opus-4-5',
      content: [{ type: 'text', text: 'Still here.' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  return `${user}\n${assistant}\n`;
}

describe('eviction with a transcript on disk', () => {
  /** A finished page session plus a watcher over a temp projects root, wired like index.ts. */
  async function setup(withTranscript: boolean): Promise<{
    sdk: SdkSessions;
    watcher: TranscriptWatcher;
    id: string;
    seen: ServerEvent[];
  }> {
    const projects = path.join(homeDir, 'projects');
    await mkdir(path.join(projects, 'proj'), { recursive: true });
    const seen: ServerEvent[] = [];
    const sdk = new SdkSessions(e => seen.push(e), limitQuery({}));
    const id = sdk.start({ prompt: 'evict me', cwd: homeDir });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    if (withTranscript) await writeFile(path.join(projects, 'proj', `${id}.jsonl`), transcriptLines(homeDir));
    const watcher = new TranscriptWatcher({ root: projects, emit: e => seen.push(e), skip: sid => sdk.owns(sid) });
    sdk.setOnEvict(sid => watcher.adopt(sid));
    return { sdk, watcher, id, seen };
  }

  it('re-lists the session as a terminal session: session.upsert, no session.removed, still listed', async () => {
    const { sdk, watcher, id, seen } = await setup(true);
    try {
      raw(sdk, id).updatedAt = Date.now() - EVICT_AFTER_MS - 1_000;
      const before = seen.length;
      sdk.evict();
      const after = seen.slice(before);
      expect(sdk.owns(id)).toBe(false);
      expect(after.some(e => e.type === 'session.removed')).toBe(false);
      const ups = after.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> => e.type === 'session.upsert');
      expect(ups.some(e => e.session.id === id)).toBe(true);
      // The session survives the eviction in both listings, exactly once in the merge.
      expect(sdk.list().some(s => s.id === id)).toBe(false);
      expect(watcher.list().some(s => s.id === id)).toBe(true);
      expect([...sdk.list(), ...watcher.list()].filter(s => s.id === id)).toHaveLength(1);
    } finally {
      watcher.stop();
    }
  });

  it('emits session.removed when no transcript exists', async () => {
    const { sdk, watcher, id, seen } = await setup(false);
    try {
      raw(sdk, id).updatedAt = Date.now() - EVICT_AFTER_MS - 1_000;
      const before = seen.length;
      sdk.evict();
      const after = seen.slice(before);
      expect(sdk.owns(id)).toBe(false);
      expect(after.some(e => e.type === 'session.removed' && e.sessionId === id)).toBe(true);
    } finally {
      watcher.stop();
    }
  });

  it('falls back to session.removed when onEvict throws', async () => {
    const { sdk, watcher, id, seen } = await setup(true);
    try {
      sdk.setOnEvict(() => {
        throw new Error('adopt blew up');
      });
      raw(sdk, id).updatedAt = Date.now() - EVICT_AFTER_MS - 1_000;
      const before = seen.length;
      sdk.evict();
      const after = seen.slice(before);
      expect(sdk.owns(id)).toBe(false);
      expect(after.some(e => e.type === 'session.removed' && e.sessionId === id)).toBe(true);
    } finally {
      watcher.stop();
    }
  });
});

describe('page session retention', () => {
  it('counts finished sessions only: running ones never push a finished session out', async () => {
    // The first three streams never finish (running), the rest do.
    const sdk = new SdkSessions(() => {}, mixedQuery(3));
    const live = [0, 1, 2].map(i => sdk.start({ prompt: `live ${i}`, cwd: homeDir }));
    const finished = [0, 1].map(i => sdk.start({ prompt: `finished ${i}`, cwd: homeDir }));
    await vi.waitFor(() => {
      expect(finished.every(id => sdk.get(id)?.status === 'done')).toBe(true);
      expect(live.every(id => raw(sdk, id).consuming)).toBe(true);
    });
    const now = Date.now();
    for (const id of finished) raw(sdk, id).updatedAt = now - 2 * 3_600_000;
    // Five sessions, but only two are finished: a cap of two is not exceeded.
    sdk.evict(now, EVICT_AFTER_MS, 2, CAP_FLOOR_MS);
    expect(finished.every(id => sdk.owns(id))).toBe(true);
    expect(live.every(id => sdk.owns(id))).toBe(true);
    // One more finished session overflows the cap: only the oldest finished one goes.
    const extra = sdk.start({ prompt: 'finished 2', cwd: homeDir });
    await vi.waitFor(() => {
      expect(sdk.get(extra)?.status).toBe('done');
    });
    raw(sdk, extra).updatedAt = now - 3 * 3_600_000;
    sdk.evict(now, EVICT_AFTER_MS, 2, CAP_FLOOR_MS);
    expect(sdk.owns(extra)).toBe(false);
    expect(finished.every(id => sdk.owns(id))).toBe(true);
    expect(live.every(id => sdk.owns(id))).toBe(true);
    for (const id of live) sdk.stop(id);
  });

  it('never caps away a finished session younger than an hour', async () => {
    const sdk = new SdkSessions(() => {}, mixedQuery(0));
    const ids = [0, 1, 2].map(i => sdk.start({ prompt: `finished ${i}`, cwd: homeDir }));
    await vi.waitFor(() => {
      expect(ids.every(id => sdk.get(id)?.status === 'done')).toBe(true);
    });
    const now = Date.now();
    for (const id of ids) raw(sdk, id).updatedAt = now - 30 * 60_000;
    // Over the cap, but every session is younger than the floor.
    sdk.evict(now, EVICT_AFTER_MS, 1, CAP_FLOOR_MS);
    expect(ids.every(id => sdk.owns(id))).toBe(true);
    // Past the floor the cap applies again.
    raw(sdk, ids[0]!).updatedAt = now - 2 * 3_600_000;
    sdk.evict(now, EVICT_AFTER_MS, 1, CAP_FLOOR_MS);
    expect(sdk.owns(ids[0]!)).toBe(false);
    expect(sdk.owns(ids[1]!)).toBe(true);
    expect(sdk.owns(ids[2]!)).toBe(true);
  });
});
