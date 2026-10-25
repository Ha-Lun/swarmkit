// Wiring tests for the opencode/agy session runtimes: validation, factory use,
// resume plumbing, the agy hook bridge and the hook route's loopback helper.
import { mkdtempSync, rmSync } from 'node:fs';
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
import { RUNTIME_MODELS } from '../src/shared/types';
import { validRuntime, validRuntimeAgent, validRuntimeEffort, validRuntimeModel } from '../server/validate.ts';
import { isLoopback } from '../server/hookauth.ts';

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

/** Real scratch dir under $HOME: resume() validates cwds like the start path does. */
const homeDir = mkdtempSync(path.join(homedir(), 'fleet-runtimes-wire-test-'));
afterAll(() => rmSync(homeDir, { recursive: true, force: true }));

function doneQuery(): AsyncIterable<SDKMessage> {
  return (async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'system', subtype: 'init', model: 'fake' } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'success' } as unknown as SDKMessage;
  })();
}

describe('runtime validation', () => {
  it('defaults to claude and rejects unknown runtimes', () => {
    expect(validRuntime(undefined)).toBe('claude');
    expect(validRuntime(null)).toBe('claude');
    expect(validRuntime('opencode')).toBe('opencode');
    expect(() => validRuntime('gpt')).toThrow("runtime must be one of 'claude', 'opencode', 'agy'");
  });

  it('models follow the runtime list', () => {
    expect(validRuntimeModel('claude', 'opus')).toBe('opus');
    expect(validRuntimeModel('claude', 'claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(validRuntimeModel('claude', undefined)).toBeUndefined();
    expect(() => validRuntimeModel('claude', 'opencode-go/glm-5.3-flash')).toThrow();
    for (const m of RUNTIME_MODELS.opencode) expect(validRuntimeModel('opencode', m)).toBe(m);
    expect(validRuntimeModel('opencode', undefined)).toBeUndefined();
    expect(() => validRuntimeModel('opencode', 'opus')).toThrow('model must be one of');
    for (const m of RUNTIME_MODELS.agy) expect(validRuntimeModel('agy', m)).toBe(m);
    expect(() => validRuntimeModel('agy', 'opus')).toThrow('model must be one of');
  });

  it('agents are fixed to lead-dev-hybrid off claude', () => {
    expect(validRuntimeAgent('claude', 'reviewer')).toBe('reviewer');
    expect(validRuntimeAgent('claude', undefined)).toBeUndefined();
    expect(() => validRuntimeAgent('claude', '../evil')).toThrow();
    expect(validRuntimeAgent('opencode', undefined)).toBeUndefined();
    expect(validRuntimeAgent('opencode', 'lead-dev-hybrid')).toBe('lead-dev-hybrid');
    expect(() => validRuntimeAgent('opencode', 'reviewer')).toThrow('lead-dev-hybrid');
    expect(validRuntimeAgent('agy', 'lead-dev-hybrid')).toBe('lead-dev-hybrid');
    expect(() => validRuntimeAgent('agy', '')).toThrow('lead-dev-hybrid');
  });

  it('effort is rejected only for opencode', () => {
    expect(validRuntimeEffort('claude', 'high')).toBe('high');
    expect(validRuntimeEffort('agy', 'low')).toBe('low');
    expect(validRuntimeEffort('opencode', undefined)).toBeUndefined();
    expect(() => validRuntimeEffort('opencode', 'high')).toThrow('not supported');
  });
});

describe('runtime sessions', () => {
  function rig() {
    const events: ServerEvent[] = [];
    const acpSeen: AcpOptions[] = [];
    const agySeen: AgyOptions[] = [];
    const sdk = new SdkSessions(e => events.push(e), () => doneQuery(), {
      acp: (o: AcpOptions): QueryFn => {
        acpSeen.push(o);
        o.onSessionId?.(`acp-conv-${acpSeen.length}`);
        return () => doneQuery();
      },
      agy: (o: AgyOptions): QueryFn => {
        agySeen.push(o);
        o.onSessionId?.(`agy-conv-${agySeen.length}`);
        return () => doneQuery();
      },
      hookBase: () => 'http://127.0.0.1:9',
    });
    return { events, acpSeen, agySeen, sdk };
  }

  it('starts opencode sessions through the acp factory with model and hook-free options', async () => {
    const { acpSeen, agySeen, sdk } = rig();
    const id = sdk.start({ prompt: 'opencode turn', cwd: homeDir, runtime: 'opencode', model: 'opencode-go/glm-5.3-flash' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    expect(agySeen).toHaveLength(0);
    expect(acpSeen).toHaveLength(1);
    expect(acpSeen[0]?.model).toBe('opencode-go/glm-5.3-flash');
    expect(acpSeen[0]?.resumeId).toBeUndefined();
    expect(sdk.list().find(s => s.id === id)?.runtime).toBe('opencode');
    expect(sdk.get(id)?.nodes.find(n => n.id === 'root')?.agentType).toBe('lead-dev-hybrid');
  });

  it('resuming an ended opencode session passes resumeId = stored runtimeSessionId', async () => {
    const { acpSeen, sdk } = rig();
    const id = sdk.start({ prompt: 'first', cwd: homeDir, runtime: 'opencode' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    expect(sdk.list().find(s => s.id === id)?.resumable).toBe(true);
    sdk.stop(id);
    await sdk.resume(id, { text: 'second' }, { cwd: homeDir });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    expect(acpSeen).toHaveLength(2);
    expect(acpSeen[1]?.resumeId).toBe('acp-conv-1');
    expect(acpSeen[1]?.model).toBeUndefined();
  });

  it('starts agy sessions through the agy factory with agent, hook and effort', async () => {
    const { acpSeen, agySeen, sdk } = rig();
    const id = sdk.start({ prompt: 'agy turn', cwd: homeDir, runtime: 'agy', model: RUNTIME_MODELS.agy[0], effort: 'low' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    expect(acpSeen).toHaveLength(0);
    expect(agySeen).toHaveLength(1);
    expect(agySeen[0]?.model).toBe(RUNTIME_MODELS.agy[0]);
    expect(agySeen[0]?.effort).toBe('low');
    expect(agySeen[0]?.agent).toBe('lead-dev-hybrid');
    expect(agySeen[0]?.hook?.url).toBe(`http://127.0.0.1:9/api/agy-hook/${id}`);
    expect(typeof agySeen[0]?.hook?.secret).toBe('string');
    expect(sdk.list().find(s => s.id === id)?.runtime).toBe('agy');
  });

  it('a non-claude model on a terminal id refuses resume with 409', async () => {
    const { sdk } = rig();
    await expect(
      sdk.resume('term-x', { text: 'hi', model: 'opencode-go/glm-5.3-flash' }, { cwd: homeDir }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('handleAgyHook denies unknown sessions and secrets, allows through canUseTool', async () => {
    const { events, agySeen, sdk } = rig();
    const id = sdk.start({ prompt: 'agy perms', cwd: homeDir, runtime: 'agy' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    const secret = agySeen[0]?.hook?.secret ?? '';
    expect(secret.length).toBeGreaterThan(0);
    const body = { conversationId: 'c1', stepIdx: 4, toolCall: { name: 'view_file', args: { AbsolutePath: '/x/y' } } };

    await expect(sdk.handleAgyHook('nope', secret, body)).resolves.toMatchObject({ status: 403 });
    await expect(sdk.handleAgyHook(id, 'wrong-secret', body)).resolves.toMatchObject({ status: 403 });

    // A claude session id never passes, even with a live agy secret.
    const claudeId = sdk.start({ prompt: 'plain', cwd: homeDir });
    await expect(sdk.handleAgyHook(claudeId, secret, body)).resolves.toMatchObject({ status: 403 });

    const pending = sdk.handleAgyHook(id, secret, body);
    await vi.waitFor(() => {
      expect(events.some(e => e.type === 'permission.request')).toBe(true);
    });
    const request = (events.find(e => e.type === 'permission.request') as { request: { id: string; tool: string; toolUseId?: string } }).request;
    expect(request.tool).toBe('Read');
    expect(request.toolUseId).toBe('c1:4');
    expect(sdk.decide(request.id, { allow: true })).toBe(true);
    await expect(pending).resolves.toEqual({ status: 200, json: { decision: 'allow' } });

    // Deny carries the user's message back to the plugin.
    const pendingDeny = sdk.handleAgyHook(id, secret, body);
    await vi.waitFor(() => {
      expect(events.filter(e => e.type === 'permission.request')).toHaveLength(2);
    });
    const denyReq = (events.filter(e => e.type === 'permission.request')[1] as { request: { id: string } }).request;
    expect(sdk.decide(denyReq.id, { allow: false, message: 'nope' })).toBe(true);
    await expect(pendingDeny).resolves.toEqual({ status: 200, json: { decision: 'deny', reason: 'nope' } });

    // Stopping unregisters the hook: the secret no longer answers.
    expect(sdk.stop(id)).toBe(true);
    await expect(sdk.handleAgyHook(id, secret, body)).resolves.toMatchObject({ status: 403 });
  });

  it('aborting the hook request withdraws the pending dashboard permission', async () => {
    const { events, agySeen, sdk } = rig();
    const id = sdk.start({ prompt: 'agy abort', cwd: homeDir, runtime: 'agy' });
    await vi.waitFor(() => {
      expect(sdk.get(id)?.status).toBe('done');
    });
    const secret = agySeen[0]?.hook?.secret ?? '';
    expect(secret.length).toBeGreaterThan(0);
    const body = { conversationId: 'c9', stepIdx: 1, toolCall: { name: 'read_file', args: { AbsolutePath: '/x' } } };
    const closer = new AbortController();
    const pending = sdk.handleAgyHook(id, secret, body, closer.signal);
    await vi.waitFor(() => {
      expect(sdk.get(id)?.pendingPermissions).toBe(1);
    });
    closer.abort();
    const out = await pending;
    expect(out.status).toBe(200);
    expect(out.json.decision).toBe('deny');
    expect(sdk.get(id)?.pendingPermissions).toBe(0);
    expect(events.some(e => e.type === 'permission.resolved' && e.allow === false)).toBe(true);
  });
});

describe('isLoopback', () => {
  it('accepts loopback forms and the bound host', () => {
    expect(isLoopback('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(isLoopback('::1', '0.0.0.0')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1', '0.0.0.0')).toBe(true);
    expect(isLoopback('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(isLoopback('10.0.0.6', '10.0.0.5')).toBe(false);
    expect(isLoopback(undefined, '127.0.0.1')).toBe(false);
    expect(isLoopback('', '127.0.0.1')).toBe(false);
  });
});
