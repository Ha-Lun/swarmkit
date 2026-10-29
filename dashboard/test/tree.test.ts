// Render test for the swarm map: sections, empty states and the Done toggle markup.
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import type { AgentNode } from '../src/shared/types.ts';
import { Tree } from '../src/client/Tree.tsx';

function node(id: string, parentId: string | null, status: AgentNode['status'], startedAt: number): AgentNode {
  return {
    id,
    sessionId: 's',
    parentId,
    kind: parentId === null ? 'main' : 'subagent',
    agentType: parentId === null ? 'lead-dev-hybrid' : `agent-${id}`,
    description: `Task ${id}`,
    model: 'claude-sonnet-5-5',
    status,
    startedAt,
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
  };
}

function render(nodes: AgentNode[]): string {
  return renderToStaticMarkup(
    createElement(Tree, {
      nodes,
      permissions: [],
      workers: [],
      workersAt: 0,
      now: 100_000,
      openNodeId: null,
      onOpen: () => undefined,
      onDecide: () => undefined,
    }),
  );
}

describe('Tree', () => {
  it('shows an empty state with no nodes', () => {
    expect(render([])).toContain('No agents yet');
  });

  it('tells a lone root that nothing was delegated yet', () => {
    const html = render([node('root', null, 'running', 0)]);
    expect(html).toContain('No subagents or workers yet');
    expect(html).not.toContain('Running</span>');
  });

  it('renders sections in order and keeps Done collapsed', () => {
    const html = render([
      node('root', null, 'running', 0),
      node('a', 'root', 'running', 10),
      node('b', 'root', 'error', 20),
      node('c', 'root', 'done', 30),
    ]);
    const order = ['aria-label="Running"', 'aria-label="Needs attention"', 'aria-label="Done"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<ul class="map-rows"[^>]* hidden=""/);
  });

  it('omits empty sections', () => {
    const html = render([node('root', null, 'running', 0), node('c', 'root', 'done', 30)]);
    expect(html).not.toContain('aria-label="Running"');
    expect(html).not.toContain('aria-label="Needs attention"');
    expect(html).toContain('aria-label="Done"');
  });
});
