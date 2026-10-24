import type { AgentNode } from '../src/shared/types.ts';
import { computeLayout } from '../src/client/Tree.tsx';

function node(id: string, parentId: string | null, startedAt: number): AgentNode {
  return {
    id,
    sessionId: 's',
    parentId,
    kind: 'subagent',
    agentType: 'tester',
    status: 'running',
    startedAt,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
  };
}

describe('computeLayout cycles', () => {
  it('places a node that is its own parent', () => {
    const nodes = [node('root', null, 0), node('self', 'self', 1)];
    const layout = computeLayout(nodes, {});
    expect(layout.placed).toHaveLength(nodes.length);
  });

  it('places a two-node parent cycle', () => {
    const nodes = [node('root', null, 0), node('a', 'b', 1), node('b', 'a', 2)];
    const layout = computeLayout(nodes, {});
    expect(layout.placed).toHaveLength(nodes.length);
  });

  it('keeps a normal 3-level tree with the parent above the child', () => {
    const nodes = [node('root', null, 0), node('mid', 'root', 1), node('leaf', 'mid', 2)];
    const layout = computeLayout(nodes, {});
    expect(layout.placed).toHaveLength(nodes.length);
    const byId = new Map(layout.placed.map((p) => [p.node.id, p] as const));
    expect(byId.get('root')!.y).toBeLessThan(byId.get('mid')!.y);
    expect(byId.get('mid')!.y).toBeLessThan(byId.get('leaf')!.y);
  });
});
