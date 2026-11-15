// Plan-limit detection in the SDK consume loop: rejected rate_limit_event and
// matching assistant rate_limit errors call onLimit once, pin the root to error
// (never "done") and close the queue. Overloads, 429s without the limit text,
// stopped sessions, fallback sessions and non-Claude runtimes never call it.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import { SdkSessions } from '../server/sdk/sessions';
import type { QueryFn } from '../server/sdk/sessions';

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
