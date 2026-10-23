import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNode, AgentNodeHead, ServerEvent } from '../src/shared/types';
import type { SessionTree, TreeInit } from '../server/model/reducer';
import type { QueryFn } from '../server/sdk/sessions';
import { SdkSessions } from '../server/sdk/sessions';

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
});
