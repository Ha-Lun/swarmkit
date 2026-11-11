// Render test for the swarm map: canvas cards, empty states and the folded Done node markup.
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
    expect(html).not.toContain('Expand all');
  });

  it('draws a card per agent as a list of buttons with their own names', () => {
    const html = render([node('root', null, 'running', 0), node('a', 'root', 'running', 10), node('b', 'root', 'error', 20)]);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Agent map"');
    expect(html.match(/class="node"/g)).toHaveLength(3);
    expect(html).toContain('agent-a');
    expect(html).toContain('Failed');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Fit map to view"');
  });

  it('folds finished children into one Done node that is an expandable button', () => {
    const html = render([
      node('root', null, 'running', 0),
      node('a', 'root', 'running', 10),
      node('c', 'root', 'done', 30),
      node('d', 'root', 'done', 40),
      node('e', 'root', 'idle', 50),
    ]);
    expect(html).toContain('Done (3)');
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-label="Done, 3 agents/);
    expect(html).toContain('data-node-id="done:root"');
    // the folded agents are not drawn, and nothing offers to fold what is not expanded
    expect(html).not.toContain('data-node-id="c"');
    expect(html).not.toContain('fold-chip');
    expect(html).toContain('Expand all');
    // the folded node opens no drawer
    const doneItem = html.slice(html.indexOf('data-node-id="done:root"'), html.indexOf('</li>', html.indexOf('data-node-id="done:root"')));
    expect(doneItem).not.toContain('aria-haspopup');
  });

  it('leaves a lone finished child as a card and offers no folding', () => {
    const html = render([node('root', null, 'running', 0), node('a', 'root', 'running', 10), node('c', 'root', 'done', 30)]);
    expect(html).toContain('data-node-id="c"');
    expect(html).not.toContain('Done (');
    expect(html).not.toContain('Expand all');
  });

  it('renders folded while the drawer agent sits in a group (the client expands it after mount)', () => {
    const nodes = [
      node('root', null, 'running', 0),
      node('a', 'root', 'running', 10),
      node('c', 'root', 'done', 30),
      node('d', 'root', 'done', 40),
    ];
    const html = renderToStaticMarkup(
      createElement(Tree, {
        nodes,
        permissions: [],
        workers: [],
        workersAt: 0,
        now: 100_000,
        openNodeId: 'c',
        onOpen: () => undefined,
        onDecide: () => undefined,
      }),
    );
    // the server render runs no effects, so the group is still folded here
    expect(html).toContain('Done (2)');
  });
});
