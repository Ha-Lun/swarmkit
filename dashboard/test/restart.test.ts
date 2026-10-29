// Restart endpoint tests: a fresh resumed query on the same id, with or without a next turn.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import { SdkSessions } from '../server/sdk/sessions';
import type { QueryFn } from '../server/sdk/sessions';
import type { AcpOptions } from '../server/runtimes/acp';
import type { AgyOptions } from '../server/runtimes/agy';

// Same minimal tree fake as sessions.test.ts (that checkout's reducer stub throws).
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

/** Real scratch dir under $HOME: start() runs the real cwd contract. */
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-restart-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

/** Queue-driven fake: records every user turn pushed into the live process, one result per turn. */
function makeQueueFake(received: string[], optionsSeen: Record<string, unknown>[]): QueryFn {
  return params => {
    optionsSeen.push((params.options ?? {}) as Record<string, unknown>);
    const iterator = params.prompt as AsyncIterable<{ message: { content: unknown } }>;
    return (async function* generator(): AsyncGenerator<any, void> {
      for await (const m of iterator) {
        const c = m.message.content;
        received.push(typeof c === 'string' ? c : JSON.stringify(c));
        yield { type: 'result', subtype: 'success' };
      }
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

function doneQuery(): AsyncIterable<SDKMessage> {
  return (async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'system', subtype: 'init', model: 'fake' } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
  })();
}

/** Internal access for the restart assertions (root status, node count). */
interface RawSession {
  consuming: boolean;
  generation: number;
  stopped: boolean;
  tree: SessionTree;
}

function raw(sdk: SdkSessions, id: string): RawSession {
  const map = (sdk as unknown as { sessions: Map<string, RawSession> }).sessions;
  expect(map.get(id)).toBeDefined();
  return map.get(id)!;
}

describe('restart', () => {
  it('(a) restarts a live idle session without pushing a turn', async () => {
    const received: string[] = [];
    const optionsSeen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, makeQueueFake(received, optionsSeen));
    const id = sdk.start({ prompt: 'hello there', cwd: homeDir });
    await vi.waitFor(() => {
      expect(received).toContain('hello there');
    });
    expect(optionsSeen).toHaveLength(1);
    expect(optionsSeen[0]?.sessionId).toBe(id);
    // Emulate the turn-ended state the real reducer produces (the mock yields no status events here).
    raw(sdk, id).tree.nodes.get('root')!.status = 'idle';

    const restarted = await sdk.restart(id, {});
    expect(restarted).toBe(id);
    await vi.waitFor(() => {
      expect(optionsSeen).toHaveLength(2);
    });
    expect(optionsSeen[1]?.resume).toBe(id);
    expect(optionsSeen[1]?.sessionId).toBeUndefined();
    expect(optionsSeen[1]?.cwd).toBe(homeDir);
    expect(optionsSeen[1]?.agent).toBe('lead-dev-hybrid');
    // No new user turn was pushed into the fresh process.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(received).toEqual(['hello there']);
    // The tree gained no new user node and the root is not running.
    expect(sdk.get(id)?.nodes).toHaveLength(1);
    expect(sdk.get(id)?.status).toBe('idle');
    sdk.stop(id);
  });

  it('(b) restart with text pushes that turn and marks the root running', async () => {
    const received: string[] = [];
    const optionsSeen: Record<string, unknown>[] = [];
    const sdk = new SdkSessions(() => {}, makeQueueFake(received, optionsSeen));
    const id = sdk.start({ prompt: 'hello there', cwd: homeDir });
    await vi.waitFor(() => {
      expect(received).toContain('hello there');
    });
    raw(sdk, id).tree.nodes.get('root')!.status = 'idle';

    const restarted = await sdk.restart(id, { text: 'second turn' });
    expect(restarted).toBe(id);
    await vi.waitFor(() => {
      expect(optionsSeen).toHaveLength(2);
    });
    expect(optionsSeen[1]?.resume).toBe(id);
    await vi.waitFor(() => {
      expect(received).toContain('second turn');
    });
    expect(sdk.get(id)?.status).toBe('running');
    sdk.stop(id);
  });

  it('(c) unknown id answers 404', async () => {
    const sdk = new SdkSessions(() => {}, makeQueueFake([], []));
    await expect(sdk.restart('nope', {})).rejects.toMatchObject({ status: 404 });
  });

  it('(d) non-claude runtime answers 400', async () => {
    const sdk = new SdkSessions(() => {}, () => doneQuery(), {
      acp: (o: AcpOptions): QueryFn => {
        o.onSessionId?.('acp-conv-1');
        return () => doneQuery();
      },
      agy: (o: AgyOptions): QueryFn => {
        o.onSessionId?.('agy-conv-1');
        return () => doneQuery();
      },
      hookBase: () => 'http://127.0.0.1:9',
    });
    const id = sdk.start({ prompt: 'opencode turn', cwd: homeDir, runtime: 'opencode' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    await expect(sdk.restart(id, {})).rejects.toMatchObject({
      status: 400,
      message: 'Restart is only for Claude sessions',
    });
  });

  describe('with a live heartbeat holder (CLAUDE_CONFIG_DIR injected)', () => {
    const base = mkdtempSync(path.join(homedir(), 'fleet-live-restart-test-'));
    const sessionsDir = path.join(base, 'sessions');
    mkdirSync(sessionsDir);

    afterAll(() => rmSync(base, { recursive: true, force: true }));

    /** Points liveHolder at the temp sessions dir for the duration of fn. */
    const withConfigDir = async (fn: () => Promise<void>): Promise<void> => {
      const prev = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = base;
      try {
        await fn();
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = prev;
      }
    };

    const writeHolder = (sessionId: string, entrypoint: string): void =>
      writeFileSync(
        path.join(sessionsDir, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid, // alive, so the default probe reports it as a holder
          sessionId,
          cwd: homeDir,
          kind: 'interactive',
          entrypoint,
          status: 'busy',
        }),
      );

    it('(e) a terminal holder refuses the restart with 409', async () => {
      await withConfigDir(async () => {
        const received: string[] = [];
        const sdk = new SdkSessions(() => {}, makeQueueFake(received, []));
        const id = sdk.start({ prompt: 'held session', cwd: homeDir });
        await vi.waitFor(() => {
          expect(received).toContain('held session');
        });
        expect(sdk.stop(id)).toBe(true);

        writeHolder(id, 'cli');
        await expect(sdk.restart(id, {})).rejects.toMatchObject({ status: 409 });
        rmSync(path.join(sessionsDir, `${process.pid}.json`));
      });
    });
  });
});
