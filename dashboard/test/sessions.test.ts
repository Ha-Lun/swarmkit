import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import type { QueryFn } from '../server/sdk/sessions';
import { SdkSessions, SessionError } from '../server/sdk/sessions';

// The data-model team builds the real reducer in parallel this checkout only
// has the throwing stub, so stand in a minimal tree fake with the final signatures.
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

interface FakeState {
  options?: { sessionId?: string };
  decision?: { behavior?: string } | null;
}

/** Fake queryFn: yields an init message, asks for a Bash permission via canUseTool, then yields a result. */
function makeFakeQuery(state: FakeState) {
  return (params: Parameters<QueryFn>[0]) => {
    const options = params.options!;
    state.options = options;
    const init = { type: 'system', subtype: 'init', session_id: options.sessionId, model: 'claude-opus-5-5' };
    return (async function* generator(): AsyncGenerator<any, void> {
      yield init;
      state.decision = await options.canUseTool!(
        'Bash',
        { command: 'ls' },
        { signal: options.abortController!.signal, toolUseID: 't1', requestId: 'req-t1' },
      );
      yield { type: 'result', subtype: 'success' };
    })() as unknown as AsyncIterable<SDKMessage>;
  };
}

describe('SdkSessions', () => {
  it('surfaces permission requests and resolves them', async () => {
    const events: ServerEvent[] = [];
    const state: FakeState = {};
    const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));

    const id = sdk.start({ prompt: 'review the fleet server', cwd: '/tmp/fake-proj', agent: 'reviewer' });
    expect(id).toBeTruthy();
    expect(sdk.owns(id)).toBe(true);
    expect(state.options?.sessionId).toBe(id);

    // The permission prompt is emitted and tracked as pending.
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission.request')).toBe(true);
    });
    const request = (events.find(e => e.type === 'permission.request')! as { request: { id: string; sessionId: string; tool: string; toolUseId?: string; input: unknown } }).request;
    expect(request.sessionId).toBe(id);
    expect(request.tool).toBe('Bash');
    expect(request.toolUseId).toBe('t1');
    expect(request.input).toEqual({ command: 'ls' });
    expect(sdk.get(id)?.permissions.map(p => p.id)).toContain(request.id);
    expect(sdk.list()[0]?.pendingPermissions).toBe(1);

    // Deciding allow resolves the fake's canUseTool promise with behavior 'allow'.
    expect(sdk.decide(request.id, { allow: true })).toBe(true);
    await vi.waitFor(() => {
      expect(state.decision?.behavior).toBe('allow');
    });
    expect(events.some(e => e.type === 'permission.resolved' && e.id === request.id && e.allow)).toBe(true);
    await vi.waitFor(() => {
      expect(sdk.get(id)?.permissions).toHaveLength(0);
    });

    // The fake iterator ends cleanly, so the root finishes as done.
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });

    const summary = sdk.list()[0]!;
    expect(summary.id).toBe(id);
    expect(summary.source).toBe('page');
    expect(summary.cwd).toBe('/tmp/fake-proj');
    expect(summary.project).toBe('fake-proj');
    expect(summary.title).toBe('review the fleet server');
    expect(summary.status).toBe('done');
    expect(summary.agent).toBe('reviewer');
    expect(summary.nodeCount).toBe(1);
    expect(summary.pendingPermissions).toBe(0);
    expect(typeof summary.startedAt).toBe('number');
    expect(typeof summary.updatedAt).toBe('number');
    expect(typeof summary.costUsd).toBe('number');
  });

  it('stop() denies pending permissions and marks the session stopped', async () => {
    const events: ServerEvent[] = [];
    const state: FakeState = {};
    const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));
    const id = sdk.start({ prompt: 'stop me', cwd: '/tmp/fake-proj' });

    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission.request')).toBe(true);
    });
    expect(sdk.stop(id)).toBe(true);
    expect(sdk.stop(id)).toBe(true); // idempotent

    await vi.waitFor(() => {
      expect(state.decision?.behavior).toBe('deny');
    });
    expect(events.some(e => e.type === 'permission.resolved' && e.allow === false)).toBe(true);
    expect(sdk.get(id)?.status).toBe('stopped');
    expect(sdk.get(id)?.permissions).toHaveLength(0);
  });

  it('rejects unknown session and permission ids', () => {
    const sdk = new SdkSessions(() => {});
    expect(sdk.owns('nope')).toBe(false);
    expect(sdk.get('nope')).toBeUndefined();
    expect(sdk.stop('nope')).toBe(false);
    expect(sdk.send('nope', 'hi')).toBe(false);
    expect(sdk.interrupt('nope')).toBe(false);
    expect(sdk.decide('missing-permission', { allow: true })).toBe(false);
  });

  describe('resume', () => {
    /** Fake query that records every options object and finishes immediately. */
    function makeRecordingQuery(optionsSeen: (Record<string, unknown> | undefined)[]) {
      return (params: Parameters<QueryFn>[0]) => {
        optionsSeen.push(params.options as Record<string, unknown> | undefined);
        return (async function* generator(): AsyncGenerator<any, void> {
          yield { type: 'system', subtype: 'init', model: 'claude-opus-5-5' };
          yield { type: 'result', subtype: 'success' };
        })() as unknown as AsyncIterable<SDKMessage>;
      };
    }

    it('refuses active sessions (page running, terminal transcript) with 409', async () => {
      const events: ServerEvent[] = [];
      const state: FakeState = {};
      const sdk = new SdkSessions(e => events.push(e), makeFakeQuery(state));
      const id = sdk.start({ prompt: 'busy session', cwd: '/tmp/fake-proj' });
      await vi.waitFor(() => {
        expect(events.some(e => e.type === 'permission.request')).toBe(true);
      });
      // Page-owned and running: 409.
      try {
        sdk.resume(id, { text: 'again' }, { cwd: '/tmp/fake-proj' });
        expect.unreachable('resume should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).status).toBe(409);
      }
      // A terminal transcript modified within the last minute counts as live: 409.
      try {
        sdk.resume('term-1', { text: 'again' }, { cwd: '/tmp/fake-proj', transcriptMtimeMs: Date.now() - 1_000 });
        expect.unreachable('resume should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SessionError);
        expect((err as SessionError).status).toBe(409);
        expect((err as SessionError).message).toBe('This session is still active in a terminal');
      }
      // Bad input (empty / oversized text, bad model): 400.
      for (const bad of [{ text: '' }, { text: 'x'.repeat(100_001) }, { text: 'ok', model: 'opencode-go/glm-5.3-flash' }] as const) {
        try {
          sdk.resume('term-1', bad as { text: string; model?: string }, { cwd: '/tmp/fake-proj' });
          expect.unreachable('resume should have thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(SessionError);
          expect((err as SessionError).status).toBe(400);
        }
      }
    });

    it('continues an ended page session with the same id, options.resume and no sessionId', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const sdk = new SdkSessions(() => {}, makeRecordingQuery(optionsSeen));
      const id = sdk.start({ prompt: 'first run', cwd: '/tmp/fake-proj' });
      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });

      const resumed = sdk.resume(id, { text: 'next message', model: 'claude-sonnet-4-5' }, { cwd: '/tmp/fake-proj' });
      expect(resumed).toBe(id);
      expect(sdk.owns(id)).toBe(true);

      await vi.waitFor(() => {
        expect(sdk.get(id)?.status).toBe('done');
      });
      expect(optionsSeen).toHaveLength(2);
      expect(optionsSeen[0]!.sessionId).toBe(id);
      expect(optionsSeen[1]!.sessionId).toBeUndefined(); // resume carries no fixed sessionId
      expect(optionsSeen[1]!.resume).toBe(id);
      expect(optionsSeen[1]!.cwd).toBe('/tmp/fake-proj');
      expect(optionsSeen[1]!.model).toBe('claude-sonnet-4-5');

      // The same id stays listed as a page session.
      expect(sdk.list().map(s => s.id)).toEqual([id]);
    });

    it('adopts an ended terminal session: same id, rebuilt tree, page-owned', async () => {
      const optionsSeen: (Record<string, unknown> | undefined)[] = [];
      const events: ServerEvent[] = [];
      const sdk = new SdkSessions(e => events.push(e), makeRecordingQuery(optionsSeen));

      const priorChild: AgentNode = {
        id: 'toolu_old1',
        sessionId: 'term-1',
        parentId: 'root',
        kind: 'subagent',
        agentType: 'tester',
        status: 'done',
        startedAt: 1,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: {},
        events: [{ id: 'e1', ts: 2, kind: 'tool_use', tool: 'Bash', toolUseId: 'toolu_old1bash', summary: 'ran something' }],
      };
      const priorRoot: AgentNode = {
        id: 'root',
        sessionId: 'term-1',
        parentId: null,
        kind: 'main',
        agentType: 'main',
        prompt: 'Old session title',
        description: 'Old session title',
        status: 'done',
        startedAt: 1,
        endedAt: 3,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: {},
        events: [],
      };
      const id = sdk.resume('term-1', { text: 'continue here' }, {
        cwd: '/tmp/fake-proj',
        nodes: [priorRoot, priorChild],
        title: 'Old session title',
      });
      expect(id).toBe('term-1');
      expect(sdk.owns('term-1')).toBe(true);
      expect(optionsSeen.at(-1)!.resume).toBe('term-1');
      expect(optionsSeen.at(-1)!.sessionId).toBeUndefined();

      const detail = sdk.get('term-1')!;
      expect(detail.source).toBe('page');
      expect(detail.title).toBe('Old session title');
      expect(detail.nodes.map(n => n.id)).toEqual(['root', 'toolu_old1']);
      expect(detail.nodes.find(n => n.id === 'root')!.status).toBe('running');
      // The prior node is back, with its events and the rebuilt tool ownership.
      expect(detail.nodes.find(n => n.id === 'toolu_old1')!.events).toHaveLength(1);
      expect(detail.nodes.find(n => n.id === 'toolu_old1')!.sessionId).toBe('term-1');
      // The resumed session ran to done (the fake query ends immediately).
      await vi.waitFor(() => {
        expect(sdk.get('term-1')?.status).toBe('done');
      });
    });

    it('survives a fileInfo lookup for a page session', () => {
      const sdk = new SdkSessions(() => {});
      const id = sdk.start({ prompt: 'cwd source', cwd: '/tmp/fake-proj' });
      expect(sdk.fileInfo(id)).toEqual({ cwd: '/tmp/fake-proj' });
      expect(sdk.fileInfo('nope')).toBeUndefined();
    });
  });
});
