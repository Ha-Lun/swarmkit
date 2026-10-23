import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTree } from '../server/model/reducer.ts';
import type { AgentNode } from '../src/shared/types.ts';
import { parseWorkerCommand, pollWorkers } from '../server/model/workers.ts';

function opencodeWorkerNode(id: string, slug: string): AgentNode {
  return {
    id,
    sessionId: 'wtest',
    parentId: 'root',
    kind: 'worker',
    agentType: 'opencode-task',
    status: 'running',
    startedAt: Date.now(),
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
    worker: { lane: 'opencode', slug },
  };
}

function agyWorkerNode(id: string, slug: string): AgentNode {
  return {
    id,
    sessionId: 'wtest',
    parentId: 'root',
    kind: 'worker',
    agentType: 'agy-task',
    status: 'running',
    startedAt: Date.now(),
    costUsd: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCounts: {},
    events: [],
    worker: { lane: 'agy', slug },
  };
}

describe('parseWorkerCommand', () => {
  it('parses an opencode-task command with agent and model flags', () => {
    const parsed = parseWorkerCommand('opencode-task start fleet-ui --agent frontend-specialist --model opencode-go/glm-5.3-flash -');
    expect(parsed).toBeDefined();
    expect(parsed!.lane).toBe('opencode');
    expect(parsed!.slug).toBe('fleet-ui');
    expect(parsed!.agent).toBe('frontend-specialist');
    expect(parsed!.model).toBe('opencode-go/glm-5.3-flash');
    // The trailing '-' means "read the prompt from stdin": no inline prompt.
    expect(parsed!.prompt).toBeUndefined();
  });

  it('parses an agy-task command with a heredoc prompt', () => {
    const command = "agy-task start fleet-core <<'EOF'\nDo worker things now\nEOF";
    const parsed = parseWorkerCommand(command);
    expect(parsed).toBeDefined();
    expect(parsed!.lane).toBe('agy');
    expect(parsed!.slug).toBe('fleet-core');
    expect(parsed!.prompt).toBe('Do worker things now');
    expect(parsed!.model).toBeUndefined();
    expect(parsed!.agent).toBeUndefined();
  });

  it('returns undefined for unrelated commands', () => {
    expect(parseWorkerCommand('echo hi && npm test')).toBeUndefined();
    expect(parseWorkerCommand('')).toBeUndefined();
  });
});

describe('pollWorkers', () => {
  let dir: string;
  let oldAgy: string | undefined;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fleet-workers-'));
    oldAgy = process.env.AGY_TASK_DIR;
    process.env.AGY_TASK_DIR = dir;
    await mkdir(join(dir, 'repo-x', 'fleet-core'), { recursive: true });
    await mkdir(join(dir, 'repo-x', 'fleet-ui'), { recursive: true });
    await writeFile(join(dir, 'repo-x', 'fleet-core', 'result.json'), JSON.stringify({ ok: true, response: 'worker finished the job' }));
    await writeFile(join(dir, 'repo-x', 'fleet-ui', 'result.json'), JSON.stringify({ ok: false, stopped_by: 'timeout' }));
  });

  afterAll(async () => {
    if (oldAgy === undefined) delete process.env.AGY_TASK_DIR;
    else process.env.AGY_TASK_DIR = oldAgy;
    await rm(dir, { recursive: true, force: true });
  });

  it('marks a successful worker done with its response as result', async () => {
    const tree = createTree('wtest', { startedAt: Date.now() });
    tree.nodes.set('w1', agyWorkerNode('w1', 'fleet-core'));
    const events = await pollWorkers(tree);
    const node = tree.nodes.get('w1')!;
    expect(node.status).toBe('done');
    expect(node.endedAt).toBeDefined();
    expect(node.worker!.ok).toBe(true);
    expect(node.result).toBe('worker finished the job');
    expect(events.some((e) => e.type === 'node.upsert' && (e as { node: { id: string } }).node.id === 'w1')).toBe(true);

    // Polling again changes nothing: the node is no longer running.
    expect(await pollWorkers(tree)).toEqual([]);
  });

  it('marks a failed worker as error and keeps stopped_by', async () => {
    const tree = createTree('wtest', { startedAt: Date.now() });
    tree.nodes.set('w2', agyWorkerNode('w2', 'fleet-ui'));
    const events = await pollWorkers(tree);
    const node = tree.nodes.get('w2')!;
    expect(node.status).toBe('error');
    expect(node.worker!.ok).toBe(false);
    expect(node.worker!.stoppedBy).toBe('timeout');
    expect(events.length).toBeGreaterThan(0);
  });

  it('ignores workers whose lane dir does not exist yet', async () => {
    const tree = createTree('wtest', { startedAt: Date.now() });
    tree.nodes.set('w3', agyWorkerNode('w3', 'no-such-slug'));
    expect(await pollWorkers(tree)).toEqual([]);
    expect(tree.nodes.get('w3')!.status).toBe('running');
  });

  it('polls opencode workers from OPENCODE_TASK_DIR', async () => {
    const dir2 = await mkdtemp(join(tmpdir(), 'fleet-opencode-'));
    const old = process.env.OPENCODE_TASK_DIR;
    process.env.OPENCODE_TASK_DIR = dir2;
    try {
      await mkdir(join(dir2, 'repo-y', 'fleet-oc'), { recursive: true });
      await writeFile(join(dir2, 'repo-y', 'fleet-oc', 'result.json'), JSON.stringify({ ok: true, changes: 'edited two files' }));
      const tree = createTree('wtest', { startedAt: Date.now() });
      tree.nodes.set('w4', opencodeWorkerNode('w4', 'fleet-oc'));
      await pollWorkers(tree);
      const node = tree.nodes.get('w4')!;
      expect(node.status).toBe('done');
      expect(node.result).toBe('edited two files');
    } finally {
      if (old === undefined) delete process.env.OPENCODE_TASK_DIR;
      else process.env.OPENCODE_TASK_DIR = old;
      await rm(dir2, { recursive: true, force: true });
    }
  });
});
