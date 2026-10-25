// Tests for the chat transcript helpers.
import { describe, expect, it } from 'vitest';
import { agentTabs, buildChat, matchWorkerTask, orbColor, orbLabel, orbState } from '../src/client/chat.ts';
import type { ActivityEvent, AgentNode, PermissionRequest, WorkerTask } from '../src/shared/types.ts';
import type { OrbState } from 'thinking-orbs';

let seq = 0;

function ev(over: Partial<ActivityEvent>): ActivityEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    ts: 1000 + seq,
    kind: 'text',
    summary: `summary ${seq}`,
    ...over,
  };
}

function node(over: Partial<AgentNode> = {}): AgentNode {
  seq += 1;
  return {
    id: `n${seq}`,
    sessionId: 's1',
    parentId: 'root',
    kind: 'subagent',
    agentType: 'agent-a',
    status: 'running',
    startedAt: 1000,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
    ...over,
  };
}

function mainNode(over: Partial<AgentNode> = {}): AgentNode {
  return node({ id: 'root', kind: 'main', parentId: null, ...over });
}

function workerTask(over: Partial<WorkerTask> = {}): WorkerTask {
  return {
    lane: 'agy',
    repo: 'repo-a',
    slug: 'slug-a',
    state: 'running',
    startedAt: 1000,
    elapsedS: 1,
    denied: 0,
    toolCounts: {},
    ...over,
  };
}

describe('buildChat tool grouping', () => {
  it('splits two groups around a text event and counts tool_use per tool', () => {
    const n = node({
      events: [
        ev({ id: 'u1', ts: 1, kind: 'tool_use', tool: 'Read', toolUseId: 'r1', summary: 'read a' }),
        ev({ id: 'u2', ts: 2, kind: 'tool_use', tool: 'Read', toolUseId: 'r2', summary: 'read b' }),
        ev({ id: 'u3', ts: 3, kind: 'tool_result', tool: 'Read', toolUseId: 'r1', summary: 'ok' }),
        ev({ id: 't1', ts: 4, kind: 'text', summary: 'hello' }),
        ev({ id: 'u4', ts: 5, kind: 'tool_use', tool: 'Bash', toolUseId: 'b1', summary: 'ls' }),
        ev({ id: 'u5', ts: 6, kind: 'tool_use', summary: 'no tool name' }),
      ],
    });
    const items = buildChat(n, []);
    expect(items.length).toBe(3);
    expect(items[0].type).toBe('tools');
    expect(items[1].type).toBe('assistant');
    expect(items[2].type).toBe('tools');
    const g1 = items[0] as Extract<(typeof items)[number], { type: 'tools' }>;
    const g2 = items[2] as Extract<(typeof items)[number], { type: 'tools' }>;
    expect(g1.id).toBe('u1');
    expect(g1.ts).toBe(1);
    expect(g1.events.map((e) => e.id)).toEqual(['u1', 'u2', 'u3']);
    expect(g1.counts).toEqual([{ tool: 'Read', count: 2 }]);
    expect(g2.id).toBe('u4');
    expect(g2.ts).toBe(5);
    expect(g2.counts).toEqual([
      { tool: 'Bash', count: 1 },
      { tool: 'Tool', count: 1 },
    ]);
  });
});

describe('buildChat handoff', () => {
  it('links tool_use with a child id, drops its tool_result, keeps unknown ids', () => {
    const child = node({ id: 'child-1' });
    const n = node({
      events: [
        ev({ id: 'h1', ts: 1, kind: 'tool_use', tool: 'Agent', toolUseId: 'child-1', summary: 'spawn' }),
        ev({ id: 'h2', ts: 2, kind: 'tool_result', tool: 'Agent', toolUseId: 'child-1', summary: 'done' }),
        ev({ id: 'k1', ts: 3, kind: 'tool_use', tool: 'Read', toolUseId: 'unknown-id', summary: 'read' }),
      ],
    });
    const items = buildChat(n, [child]);
    expect(items.length).toBe(2);
    expect(items[0]).toEqual({ type: 'handoff', id: 'h1', ts: 1, childId: 'child-1' });
    expect(items[1].type).toBe('tools');
    const g = items[1] as Extract<(typeof items)[number], { type: 'tools' }>;
    expect(g.events.map((e) => e.id)).toEqual(['k1']);
  });

  it('ends a running tools group at a handoff', () => {
    const child = node({ id: 'child-9' });
    const n = node({
      events: [
        ev({ id: 'a1', ts: 1, kind: 'tool_use', tool: 'Read', toolUseId: 'x1', summary: 'read' }),
        ev({ id: 'h1', ts: 2, kind: 'tool_use', tool: 'Task', toolUseId: 'child-9', summary: 'spawn' }),
        ev({ id: 'a2', ts: 3, kind: 'tool_use', tool: 'Bash', toolUseId: 'x2', summary: 'run' }),
      ],
    });
    const items = buildChat(n, [child]);
    expect(items.map((i) => i.type)).toEqual(['tools', 'handoff', 'tools']);
  });
});

describe('buildChat text mapping', () => {
  it('uses detail with summary fallback; permission/result/system map', () => {
    const n = node({
      events: [
        ev({ id: 'u1', ts: 1, kind: 'user', summary: 'usum', detail: 'udetail' }),
        ev({ id: 'u2', ts: 2, kind: 'user', summary: 'usum2' }),
        ev({ id: 'a1', ts: 3, kind: 'text', summary: 'asum', detail: 'adetail' }),
        ev({ id: 'a2', ts: 4, kind: 'text', summary: 'asum2' }),
        ev({ id: 't1', ts: 5, kind: 'thinking', summary: 'tsum', detail: 'tdetail' }),
        ev({ id: 't2', ts: 6, kind: 'thinking', summary: 'tsum2' }),
        ev({ id: 'p1', ts: 7, kind: 'permission', tool: 'Edit', summary: 'perm' }),
        ev({ id: 'r1', ts: 8, kind: 'result', summary: 'done', isError: true }),
        ev({ id: 's1', ts: 9, kind: 'system', summary: 'sys' }),
      ],
    });
    const items = buildChat(n, []);
    expect(items[0]).toEqual({ type: 'user', id: 'u1', ts: 1, text: 'udetail' });
    expect(items[1]).toEqual({ type: 'user', id: 'u2', ts: 2, text: 'usum2' });
    expect(items[2]).toEqual({ type: 'assistant', id: 'a1', ts: 3, text: 'adetail' });
    expect(items[3]).toEqual({ type: 'assistant', id: 'a2', ts: 4, text: 'asum2' });
    expect(items[4]).toEqual({ type: 'thinking', id: 't1', ts: 5, text: 'tdetail', summary: 'tsum' });
    expect(items[5]).toEqual({ type: 'thinking', id: 't2', ts: 6, text: 'tsum2', summary: 'tsum2' });
    expect(items[6].type).toBe('permission');
    expect((items[6] as { event: ActivityEvent }).event.id).toBe('p1');
    expect(items[7]).toEqual({ type: 'note', id: 'r1', ts: 8, text: 'done', isError: true });
    expect(items[8]).toEqual({ type: 'note', id: 's1', ts: 9, text: 'sys', isError: undefined });
  });
});

describe('orbState', () => {
  it('waiting wins and empty events connect', () => {
    expect(orbState(node({ events: [ev({ kind: 'text', summary: 'x' })] }), true)).toBe('listening');
    expect(orbState(node({ events: [] }), false)).toBe('connecting');
  });
  it('thinking and text', () => {
    expect(orbState(node({ events: [ev({ kind: 'thinking', summary: 't' })] }), false)).toBe('solving');
    expect(orbState(node({ events: [ev({ kind: 'text', summary: 't' })] }), false)).toBe('composing');
  });
  it('searching tools across kinds', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']) {
      for (const kind of ['tool_use', 'tool_result', 'permission'] as const) {
        expect(orbState(node({ events: [ev({ kind, tool, summary: 'x' })] }), false)).toBe('searching');
      }
    }
  });
  it('shaping tools', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(orbState(node({ events: [ev({ kind: 'tool_use', tool, summary: 'x' })] }), false)).toBe('shaping');
    }
  });
  it('weaving for Agent/Task and task-runner Bash', () => {
    expect(orbState(node({ events: [ev({ kind: 'tool_use', tool: 'Agent', summary: 'x' })] }), false)).toBe('weaving');
    expect(orbState(node({ events: [ev({ kind: 'tool_use', tool: 'Task', summary: 'x' })] }), false)).toBe('weaving');
    expect(orbState(node({ events: [ev({ kind: 'tool_use', tool: 'Bash', summary: 'run agy-task foo' })] }), false)).toBe('weaving');
    expect(orbState(node({ events: [ev({ kind: 'tool_result', tool: 'Bash', summary: 'x', detail: 'opencode-task bar' })] }), false)).toBe('weaving');
  });
  it('plain Bash and anything else works', () => {
    expect(orbState(node({ events: [ev({ kind: 'tool_use', tool: 'Bash', summary: 'ls -la' })] }), false)).toBe('working');
    expect(orbState(node({ events: [ev({ kind: 'tool_use', tool: 'Unknown', summary: 'x' })] }), false)).toBe('working');
    expect(orbState(node({ events: [ev({ kind: 'user', summary: 'hi' })] }), false)).toBe('working');
    expect(orbState(node({ events: [ev({ kind: 'system', summary: 's' })] }), false)).toBe('working');
    expect(orbState(node({ events: [ev({ kind: 'result', summary: 'r' })] }), false)).toBe('working');
  });
  it('uses the last event', () => {
    const n = node({
      events: [
        ev({ kind: 'thinking', summary: 't' }),
        ev({ kind: 'tool_use', tool: 'Read', summary: 'r' }),
      ],
    });
    expect(orbState(n, false)).toBe('searching');
  });
});

describe('orbLabel', () => {
  it('maps every state', () => {
    const cases: Array<[OrbState, string]> = [
      ['listening', 'Waiting for you…'],
      ['connecting', 'Starting…'],
      ['solving', 'Thinking…'],
      ['composing', 'Writing…'],
      ['searching', 'Searching…'],
      ['shaping', 'Editing…'],
      ['weaving', 'Handing off…'],
      ['working', 'Working…'],
      ['breathing', 'Idle'],
    ];
    for (const [state, label] of cases) expect(orbLabel(state)).toBe(label);
    expect(orbLabel('breathing')).toBe('Idle');
  });
});

describe('orbColor', () => {
  it('worker lanes', () => {
    expect(orbColor(node({ kind: 'worker', worker: { lane: 'agy', slug: 'a' } }))).toBe('#ffb547');
    expect(orbColor(node({ kind: 'worker', worker: { lane: 'opencode', slug: 'a' } }))).toBe('#2ee6c8');
    expect(orbColor(node({ kind: 'worker' }))).toBe('#2ee6c8');
    expect(orbColor(node({ kind: 'worker', worker: { lane: 'opencode', slug: 'a' } }), workerTask({ lane: 'agy' }))).toBe('#ffb547');
  });
  it('model names case-insensitive with task override', () => {
    expect(orbColor(node({ kind: 'subagent', model: 'claude-opus-5-5' }))).toBe('#d9ccff');
    expect(orbColor(node({ kind: 'subagent', model: 'Claude-Sonnet-4' }))).toBe('#2ee6c8');
    expect(orbColor(node({ kind: 'subagent', model: 'haiku-3' }))).toBe('#b4b1d0');
    expect(orbColor(node({ kind: 'subagent', model: 'sonnet-x' }), workerTask({ model: 'opus-y' }))).toBe('#d9ccff');
    expect(orbColor(mainNode({ model: undefined }))).toBe('#d9ccff');
    expect(orbColor(node({ kind: 'subagent', model: 'other-model' }))).toBe('#b4b1d0');
    expect(orbColor(node({ kind: 'subagent' }))).toBe('#b4b1d0');
  });
});

describe('agentTabs', () => {
  const now = 100_000;
  function perm(nodeId: string): PermissionRequest {
    return { id: `p-${nodeId}`, sessionId: 's1', nodeId, tool: 'Edit', input: {}, createdAt: now };
  }
  it('linger windows include/exclude', () => {
    const nodes = [
      node({ id: 'done-in', status: 'done', startedAt: 1, endedAt: now - 4000 }),
      node({ id: 'done-out', status: 'done', startedAt: 2, endedAt: now - 6000 }),
      node({ id: 'err-in', status: 'error', startedAt: 3, endedAt: now - 9000 }),
      node({ id: 'err-out', status: 'error', startedAt: 4, endedAt: now - 11000 }),
      node({ id: 'idle-in', status: 'idle', startedAt: 5, endedAt: now - 1000 }),
      node({ id: 'stop-in', status: 'stopped', startedAt: 6, endedAt: now - 1000 }),
      node({ id: 'no-end', status: 'done', startedAt: 7 }),
      node({ id: 'old-run', status: 'done', startedAt: 8, endedAt: now - 5000 }),
    ];
    const tabs = agentTabs(nodes, now, []);
    const byId = new Map(tabs.map((t) => [t.node.id, t.phase]));
    expect(byId.get('done-in')).toBe('done');
    expect(byId.has('done-out')).toBe(false);
    expect(byId.get('err-in')).toBe('error');
    expect(byId.has('err-out')).toBe(false);
    expect(byId.get('idle-in')).toBe('done');
    expect(byId.get('stop-in')).toBe('error');
    expect(byId.has('no-end')).toBe(false);
    expect(byId.get('old-run')).toBe('done');
  });
  it('waiting/live/permission/root/sort', () => {
    const root = mainNode({ status: 'running', startedAt: 1 });
    const orphan = node({ id: 'orphan', kind: 'subagent', parentId: null, status: 'running', startedAt: 2 });
    const a = node({ id: 'a', status: 'running', startedAt: 20 });
    const b = node({ id: 'b', status: 'waiting', startedAt: 10 });
    const c = node({ id: 'c', status: 'running', startedAt: 15 });
    const tabs = agentTabs([a, root, orphan, b, c], now, [perm('c')]);
    expect(tabs.map((t) => t.node.id)).toEqual(['b', 'c', 'a']);
    expect(tabs.map((t) => t.phase)).toEqual(['waiting', 'waiting', 'live']);
  });
});

describe('matchWorkerTask', () => {
  it('matches by session+node and by lane+slug', () => {
    const wNode = node({ id: 'w1', sessionId: 's1', kind: 'worker', worker: { lane: 'agy', slug: 'slug-a' } });
    const byIds = workerTask({ sessionId: 's1', nodeId: 'w1', lane: 'opencode', slug: 'other' });
    const byLane = workerTask({ lane: 'agy', slug: 'slug-a' });
    expect(matchWorkerTask(wNode, [byLane, byIds])).toBe(byLane);
    expect(matchWorkerTask(wNode, [byIds])).toBe(byIds);
    expect(matchWorkerTask(wNode, [workerTask({ lane: 'agy', slug: 'nope' })])).toBeUndefined();
  });
  it('non-worker is undefined', () => {
    const n = node({ kind: 'subagent' });
    expect(matchWorkerTask(n, [workerTask({ sessionId: 's1', nodeId: n.id })])).toBeUndefined();
    expect(matchWorkerTask(mainNode(), [])).toBeUndefined();
  });
});

describe('review findings', () => {
  it('dropping a handoff tool_result ends the tools group', () => {
    const child = node({ id: 'child-drop' });
    const n = node({
      events: [
        ev({ id: 'r1', ts: 1, kind: 'tool_use', tool: 'Read', toolUseId: 'x1', summary: 'read' }),
        ev({ id: 'h2', ts: 2, kind: 'tool_result', tool: 'Agent', toolUseId: 'child-drop', summary: 'done' }),
        ev({ id: 'r2', ts: 3, kind: 'tool_use', tool: 'Bash', toolUseId: 'x2', summary: 'run' }),
      ],
    });
    const items = buildChat(n, [child]);
    expect(items.map((x) => x.type)).toEqual(['tools', 'tools']);
  });
  it('stale permission on ended nodes falls through; future endedAt excluded', () => {
    const now = 100_000;
    const permFor = (nodeId: string): PermissionRequest => ({
      id: `p-${nodeId}`,
      sessionId: 's1',
      nodeId,
      tool: 'Edit',
      input: {},
      createdAt: now,
    });
    const doneNode = node({ id: 'done-stale', status: 'done', startedAt: 1, endedAt: now - 1000 });
    const errNode = node({ id: 'err-stale', status: 'error', startedAt: 2, endedAt: now - 1000 });
    const runNode = node({ id: 'run-perm', status: 'running', startedAt: 3 });
    const futureNode = node({ id: 'future', status: 'done', startedAt: 4, endedAt: now + 1000 });
    const tabs = agentTabs(
      [doneNode, errNode, runNode, futureNode],
      now,
      [permFor('done-stale'), permFor('err-stale'), permFor('run-perm')],
    );
    const byId = new Map(tabs.map((t) => [t.node.id, t.phase]));
    expect(byId.get('done-stale')).toBe('done');
    expect(byId.get('err-stale')).toBe('error');
    expect(byId.get('run-perm')).toBe('waiting');
    expect(byId.has('future')).toBe(false);
  });
  it('orbState returns breathing for idle/done before events', () => {
    expect(
      orbState(node({ status: 'idle', events: [ev({ kind: 'thinking', summary: 't' })] }), false),
    ).toBe('breathing');
    expect(
      orbState(node({ status: 'done', events: [ev({ kind: 'text', summary: 't' })] }), false),
    ).toBe('breathing');
    expect(
      orbState(node({ status: 'idle', events: [ev({ kind: 'tool_use', tool: 'Read', summary: 'x' })] }), false),
    ).toBe('breathing');
  });
});
