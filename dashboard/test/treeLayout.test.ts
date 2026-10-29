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

describe('computeLayout bands', () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => node(`k${i}`, 'root', i + 1));

  it('wraps many sibling leaves into rows under one band', () => {
    const nodes = [node('root', null, 0), ...kids(9)];
    const layout = computeLayout(nodes, {});
    expect(layout.placed).toHaveLength(10);
    expect(layout.groups).toHaveLength(1);
    const band = layout.groups[0];
    expect(band.members).toHaveLength(9);
    const ys = new Set(layout.placed.filter((p) => p.node.id !== 'root').map((p) => p.y));
    expect(ys.size).toBe(3);
    // The band wraps its cards with padding and starts below the parent.
    const root = layout.placed.find((p) => p.node.id === 'root')!;
    expect(band.y).toBeGreaterThan(root.y);
    for (const p of layout.placed.filter((q) => q.node.id !== 'root')) {
      expect(p.x).toBeGreaterThan(band.x);
      expect(p.x).toBeLessThan(band.x + band.w);
      expect(p.y).toBeGreaterThan(band.y);
    }
  });

  it('does not wrap four or fewer leaves', () => {
    const layout = computeLayout([node('root', null, 0), ...kids(4)], {});
    expect(layout.groups).toHaveLength(0);
  });

  it('puts the row below the tallest card above it', () => {
    const nodes = [node('root', null, 0), node('a', 'root', 1)];
    const tall = computeLayout(nodes, { root: 200 });
    const short = computeLayout(nodes, { root: 100 });
    const yOf = (l: ReturnType<typeof computeLayout>) => l.placed.find((p) => p.node.id === 'a')!.y;
    expect(yOf(tall) - yOf(short)).toBe(100);
  });

  it('centres a parent over its children', () => {
    const layout = computeLayout([node('root', null, 0), node('a', 'root', 1), node('b', 'root', 2)], {});
    const x = (id: string) => layout.placed.find((p) => p.node.id === id)!.x;
    expect(x('root')).toBeCloseTo((x('a') + x('b')) / 2);
  });

  it('lays out folded done nodes like any other node', () => {
    const done = { ...node('done:root', 'root', 99), status: 'done' as const };
    const layout = computeLayout([node('root', null, 0), node('a', 'root', 1), done], {});
    expect(layout.placed.map((p) => p.node.id).sort()).toEqual(['a', 'done:root', 'root']);
    const x = (id: string) => layout.placed.find((p) => p.node.id === id)!.x;
    expect(x('done:root')).toBeGreaterThan(x('a'));
  });
});
