import { readFile } from 'node:fs/promises';
import { applyMessage, createTree, ownerOf, setStatus } from '../server/model/reducer.ts';
import { estimateCost } from '../server/model/pricing.ts';
import type { AgentNode, ServerEvent } from '../src/shared/types.ts';

function fixtureUrl(name: string): URL {
  return new URL(`./fixtures/transcript/${name}`, import.meta.url);
}

async function loadFixture(name: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(fixtureUrl(name), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function flatten(events: ServerEvent[][]): ServerEvent[] {
  return events.flat();
}

describe('reducer: transcript fixture', () => {
  it('builds root + subagent + worker from the main file and the subagent file', async () => {
    const main = await loadFixture('main.jsonl');
    const sub = await loadFixture('subagent-agent-1.jsonl');
    const tree = createTree('fix1', { startedAt: Date.parse('2025-01-01T10:00:00.000Z') });

    const firstPass = flatten(main.map((m) => applyMessage(tree, m)));
    const subPass = flatten(sub.map((m) => applyMessage(tree, m, { nodeId: 'toolu_sub1' })));
    expect(firstPass.length).toBeGreaterThan(0);
    expect(subPass.length).toBeGreaterThan(0);

    const root = tree.nodes.get('root')!;
    expect(root.prompt).toBe('Fix the fleet dashboard');
    expect(root.description).toBe('Fix the fleet dashboard');
    expect(root.model).toBe('claude-opus-4-5');
    // Streaming dedup: both lines share message.id msg_1, so usage counted once (+ msg_2 once).
    expect(root.tokens.input).toBe(140);
    expect(root.tokens.output).toBe(14);
    expect(root.costUsd).toBeCloseTo(
      estimateCost('claude-opus-4-5', { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }) +
        estimateCost('claude-opus-4-5', { input: 40, output: 4, cacheRead: 0, cacheWrite: 0 }),
      12,
    );
    expect(root.toolCounts).toEqual({ Agent: 1, Bash: 1 });
    expect(firstPass.filter((e) => e.type === 'node.event').map((e) => (e as { event: { kind: string } }).event.kind)).toEqual([
      'user',
      'text',
      'tool_use',
      'tool_use',
      'tool_result',
    ]);

    // Subagent node created from the Agent tool_use (id = tool_use id).
    const child = tree.nodes.get('toolu_sub1')!;
    expect(child.kind).toBe('subagent');
    expect(child.parentId).toBe('root');
    expect(child.agentType).toBe('backend-specialist');
    expect(child.description).toBe('Probe the server');
    expect(child.prompt).toBe('Check the event routes');
    expect(child.status).toBe('running'); // async_launched keeps it running
    // Alias 'sonnet' replaced by the real model id from the child's assistant message.
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.toolCounts).toEqual({ Read: 1, Bash: 1 });
    expect(child.result).toBe('Looking at the routes.');
    expect(child.costUsd).toBeGreaterThan(0);
    expect(tree.toolOwner.get('toolu_sub1')).toBe('root');
    expect(tree.toolOwner.get('toolu_r1')).toBe('toolu_sub1');
    expect(ownerOf(tree, 'toolu_r1')).toBe('toolu_sub1');

    // Worker node created from the agy-task Bash call.
    const worker = tree.nodes.get('toolu_worker1')!;
    expect(worker.kind).toBe('worker');
    expect(worker.agentType).toBe('agy-task');
    expect(worker.worker).toEqual({ lane: 'agy', slug: 'fleet-core' });
    // The caller's own Bash description wins; the slug is the fallback.
    expect(worker.description).toBe('Start agy worker');
    expect(worker.prompt).toBe('Do worker things now');
    expect(worker.startedAt).toBe(Date.parse('2025-01-01T10:00:07.000Z'));
    expect(worker.status).toBe('running');

    // Background agent id registered.
    expect(tree.agentIds!.get('agent-1')).toBe('toolu_sub1');
  });

  it('emits no events when the same lines are applied twice', async () => {
    const main = await loadFixture('main.jsonl');
    const sub = await loadFixture('subagent-agent-1.jsonl');
    const tree = createTree('fix1', { startedAt: Date.parse('2025-01-01T10:00:00.000Z') });
    main.forEach((m) => applyMessage(tree, m));
    sub.forEach((m) => applyMessage(tree, m, { nodeId: 'toolu_sub1' }));

    const second = flatten([...main, ...sub].map((m, i) =>
      i < main.length ? applyMessage(tree, m) : applyMessage(tree, m, { nodeId: 'toolu_sub1' }),
    ));
    expect(second).toEqual([]);
    expect(tree.nodes.get('root')!.toolCounts).toEqual({ Agent: 1, Bash: 1 });
    expect(tree.nodes.get('toolu_sub1')!.toolCounts).toEqual({ Read: 1, Bash: 1 });
    expect(tree.nodes.get('root')!.tokens.input).toBe(140);
  });
});

describe('reducer: SDK sequence', () => {
  it('routes by parent_tool_use_id, finishes the child and reads total_cost_usd', () => {
    const tree = createTree('sdk1', { startedAt: 1_700_000_000_000 });
    const usage = { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    expect(applyMessage(tree, { type: 'system', subtype: 'init', model: 'claude-opus-4-5', session_id: 'sdk1' }).length).toBeGreaterThan(0);
    expect(tree.nodes.get('root')!.model).toBe('claude-opus-4-5');

    // Assistant starts a subagent.
    const started = flatten([
      applyMessage(tree, {
        type: 'assistant',
        uuid: 'm1',
        timestamp: 1_700_000_001_000,
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-5',
          content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Agent', input: { subagent_type: 'tester', description: 'Run checks' } }],
          usage,
        },
      }),
    ]);
    const child = tree.nodes.get('toolu_s1')!;
    expect(child.kind).toBe('subagent');
    expect(child.status).toBe('running');
    expect(child.agentType).toBe('tester');
    expect(started.some((e) => e.type === 'node.event' && (e as { event: { kind: string } }).event.kind === 'tool_use')).toBe(true);
    expect(ownerOf(tree, 'toolu_s1')).toBe('root');

    // Assistant message in the subagent context lands on the child node.
    applyMessage(tree, {
      type: 'assistant',
      uuid: 'm2',
      parent_tool_use_id: 'toolu_s1',
      timestamp: 1_700_000_002_000,
      message: {
        id: 'msg_2',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Sub working.' }],
        usage,
      },
    });
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.result).toBe('Sub working.');
    expect(child.tokens.input).toBe(200);

    // Unknown parent id creates a placeholder subagent under root.
    applyMessage(tree, {
      type: 'assistant',
      uuid: 'm3',
      parent_tool_use_id: 'toolu_ghost',
      message: { id: 'msg_3', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'hi' }], usage },
    });
    expect(tree.nodes.get('toolu_ghost')!.parentId).toBe('root');
    expect(tree.nodes.get('toolu_ghost')!.kind).toBe('subagent');

    // Tool result finishes the child.
    applyMessage(tree, {
      type: 'user',
      uuid: 'm4',
      timestamp: 1_700_000_003_000,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'Sub done', is_error: false }] },
    });
    expect(child.status).toBe('done');
    expect(child.endedAt).toBeDefined();
    expect(child.result).toBe('Sub done');

    // task_notification completed -> summary becomes the result.
    applyMessage(tree, {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'toolu_s1',
      status: 'completed',
      summary: 'All good',
    });
    expect(child.result).toBe('All good');

    // Final result message.
    const final = flatten([
      applyMessage(tree, {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.42,
        duration_ms: 1000,
        is_error: false,
        result: 'Session finished',
      }),
    ]);
    const root = tree.nodes.get('root')!;
    expect(root.costUsd).toBe(0.42);
    expect(root.status).toBe('idle');
    expect(final.some((e) => e.type === 'node.event' && (e as { event: { kind: string } }).event.kind === 'result')).toBe(true);
  });

  it('ignores unknown shapes and handles setStatus', () => {
    const tree = createTree('sdk2', { startedAt: 0 });
    expect(applyMessage(tree, { type: 'attachment', data: 'x' })).toEqual([]);
    expect(applyMessage(tree, 'nonsense')).toEqual([]);
    expect(applyMessage(tree, null)).toEqual([]);

    const upsert = setStatus(tree, 'root', 'waiting');
    expect(upsert).toHaveLength(1);
    expect(tree.nodes.get('root')!.status).toBe('waiting');
    expect(setStatus(tree, 'missing', 'done')).toEqual([]);
  });

  describe('placeholder reparenting', () => {
    // A subagent line whose parent_tool_use_id has no Agent tool_use YET (streamed transcripts
    // and subagent meta.json can produce this): the node starts under 'root'.
    const ghostLine = {
      type: 'assistant' as const,
      uuid: 'g1',
      parent_tool_use_id: 'toolu_ghost2',
      timestamp: 1_700_000_005_000,
      message: { id: 'msg_g1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Sub line first.' }] },
    };
    const agentUse = {
      type: 'assistant' as const,
      uuid: 'g2',
      timestamp: 1_700_000_001_000,
      message: {
        id: 'msg_g2',
        model: 'claude-opus-4-5',
        content: [{ type: 'tool_use', id: 'toolu_ghost2', name: 'Agent', input: { subagent_type: 'tester', description: 'Run checks', prompt: 'go check' } }],
      },
    };
    const usage = { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    function eventsOf(node: AgentNode): string {
      return JSON.stringify(node.events.map((e) => e.id));
    }
    const fromRoot = {
      type: 'assistant' as const,
      uuid: 'g3',
      timestamp: 1_700_000_010_000,
      message: { id: 'msg_g3', model: 'claude-opus-4-5', content: [{ type: 'text', text: 'Root still alive.' }], usage },
    };

    it('reparents a placeholder when its Agent tool_use arrives later', () => {
      const tree = createTree('ph1', { startedAt: 1_700_000_000_000 });
      applyMessage(tree, ghostLine);
      const node = tree.nodes.get('toolu_ghost2')!;
      expect(node.parentId).toBe('root'); // provisional until the tool_use is known
      expect(node.agentType).toBe('general-purpose');

      const events = applyMessage(tree, agentUse);
      expect(node.parentId).toBe('root'); // reparented to the calling node (root here)
      expect(node.agentType).toBe('tester'); // backfilled from the Agent input
      expect(node.description).toBe('Run checks');
      expect(node.prompt).toBe('go check');
      expect(node.startedAt).toBe(1_700_000_001_000); // backdated to the Agent tool_use
      const upsert = events.filter((e) => e.type === 'node.upsert' && (e as { node: { id: string } }).node.id === 'toolu_ghost2');
      expect(upsert.length).toBeGreaterThan(0);
      // The caller's later lines do not touch the (already correct) node: one backfill only.
      applyMessage(tree, fromRoot);
      expect(node.parentId).toBe('root');
    });

    it('is order-independent: a second Agent tool_use for the same id changes nothing', () => {
      const tree = createTree('ph2', { startedAt: 1_700_000_000_000 });
      applyMessage(tree, agentUse);
      applyMessage(tree, ghostLine);
      const node = tree.nodes.get('toolu_ghost2')!;
      expect(node.parentId).toBe('root');
      expect(node.agentType).toBe('tester');
      expect(node.description).toBe('Run checks');
      expect(node.prompt).toBe('go check');
      // A duplicated tool_use is a no-op for the node's fields.
      const before = eventsOf(node);
      applyMessage(tree, agentUse);
      expect(eventsOf(node)).toBe(before);
    });

    it('reparents to a nested calling node, not just root', () => {
      const tree = createTree('ph3', { startedAt: 1_700_000_000_000 });
      // caller = a real subagent node under root
      applyMessage(tree, {
        type: 'assistant',
        uuid: 'c1',
        timestamp: 1_700_000_000_500,
        message: {
          id: 'msg_c1',
          model: 'claude-opus-4-5',
          content: [{ type: 'tool_use', id: 'toolu_c1', name: 'Agent', input: { subagent_type: 'planner' } }],
          usage,
        },
      });
      // The Agent tool_use arrives from within the nested caller's context.
      const use = structuredClone(agentUse) as typeof agentUse;
      use.parent_tool_use_id = 'toolu_c1';
      use.message = {
        id: 'msg_g2b',
        model: 'claude-opus-4-5',
        content: [{ type: 'tool_use', id: 'toolu_ghost2', name: 'Agent', input: { subagent_type: 'tester', description: 'Nested check', prompt: 'deep' } }],
      };
      applyMessage(tree, use);
      applyMessage(tree, ghostLine);
      const node = tree.nodes.get('toolu_ghost2')!;
      expect(node.parentId).toBe('toolu_c1');
      expect(node.agentType).toBe('tester');
      expect(node.description).toBe('Nested check');
      expect(node.prompt).toBe('deep');
    });
  });

  describe('queue-operation task notifications', () => {
    const notification = (id: string, status: string, summary: string, operation = 'enqueue') => ({
      type: 'queue-operation',
      operation,
      timestamp: 1_700_000_010_000,
      content:
        `<task-notification>\n<task-id>b7f813pau</task-id>\n<tool-use-id>${id}</tool-use-id>\n` +
        `<output-file>/tmp/fleet/output.txt</output-file>\n<status>${status}</status>\n` +
        `<summary>Background command ${JSON.stringify('npm test')} ${summary}</summary>\n</task-notification>`,
    });

    function treeWithWorkerAndSubagent() {
      const tree = createTree('notif1', { startedAt: 1_700_000_000_000 });
      applyMessage(tree, {
        type: 'assistant',
        uuid: 'm1',
        timestamp: 1_700_000_001_000,
        message: {
          id: 'msg_1',
          model: 'claude-opus-4-5',
          content: [
            { type: 'tool_use', id: 'toolu_w1', name: 'Bash', input: { command: "agy-task start p1 <<'EOF'\nwork\nEOF" } },
            { type: 'tool_use', id: 'toolu_s1', name: 'Agent', input: { subagent_type: 'tester', description: 'Run checks' } },
          ],
        },
      });
      return tree;
    }

    it('marks a failed worker node as error from the notification', () => {
      const tree = treeWithWorkerAndSubagent();
      const events = flatten([
        applyMessage(tree, notification('toolu_w1', 'failed', 'failed with exit code 1')),
      ]);
      const worker = tree.nodes.get('toolu_w1')!;
      expect(worker.status).toBe('error');
      expect(worker.endedAt).toBe(1_700_000_010_000);
      // The summary becomes the result when there is none yet.
      expect(worker.result).toContain('failed with exit code 1');
      expect(events.some((e) => e.type === 'node.upsert' && (e as { node: { id: string } }).node.id === 'toolu_w1')).toBe(true);
    });

    it('marks a completed subagent done and keeps an earlier result text', () => {
      const tree = treeWithWorkerAndSubagent();
      tree.nodes.get('toolu_s1')!.result = 'Checks all green.';
      applyMessage(tree, notification('toolu_s1', 'completed', 'completed'));
      const sub = tree.nodes.get('toolu_s1')!;
      expect(sub.status).toBe('done');
      expect(sub.endedAt).toBe(1_700_000_010_000);
      expect(sub.result).toBe('Checks all green.'); // result was not empty: summary does not win
      // A second notification is ignored: the node is no longer running.
      expect(applyMessage(tree, notification('toolu_s1', 'failed', 'failed now'))).toEqual([]);
      expect(sub.status).toBe('done');
    });

    it('keeps a known worker.ok verdict over the notification status', () => {
      const tree = treeWithWorkerAndSubagent();
      // The registry already read result.json (ok false) before the transcript line arrives.
      const worker = tree.nodes.get('toolu_w1')!;
      worker.worker = { lane: 'agy', slug: 'p1', ok: false };
      applyMessage(tree, notification('toolu_w1', 'completed', 'completed'));
      expect(worker.status).toBe('error'); // worker.ok false wins over the notification
    });

    it('ignores remove operations and unknown ids', () => {
      const tree = treeWithWorkerAndSubagent();
      expect(applyMessage(tree, notification('toolu_w1', 'failed', 'failed', 'remove'))).toEqual([]);
      expect(tree.nodes.get('toolu_w1')!.status).toBe('running');
      expect(applyMessage(tree, notification('toolu_ghost', 'completed', 'completed'))).toEqual([]);
      expect(applyMessage(tree, { type: 'queue-operation', operation: 'enqueue', content: 'no tags in here' })).toEqual([]);
    });
  });
});
