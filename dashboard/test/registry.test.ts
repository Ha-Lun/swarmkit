import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerRegistry } from '../server/registry.ts';
import type { WorkerTask } from '../src/shared/types';

/** Injectable liveness: only this fake pid counts as a running worker. */
const LIVE_PID = 424242;
const isAlive = (pid: number): boolean => pid === LIVE_PID;

const CLK = '2026-01-01T10:00:00.000Z';

/** A sample opencode stream: texts, tool calls (some refused by the permission rules), a finish. */
const OPENCODE_LOG = [
  'opencode-task ► w1 · model opencode-go/glm-5.3-flash (not JSON: stderr banner)',
  JSON.stringify({ type: 'step_start', timestamp: CLK }),
  JSON.stringify({ type: 'text', part: { text: 'On it.\nRunning the tests now.' }, timestamp: CLK }),
  JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'running', input: { command: 'npm test' } } }, timestamp: CLK }),
  JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'error', error: 'blocked by a rule which prevents writing outside', input: { command: 'rm -rf /' } } }, timestamp: CLK }),
  JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'error', error: 'connection refused', input: {} } }, timestamp: CLK }),
  JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'error', error: 'permission rejected by policy', input: { filePath: 'src/app.ts' } } }, timestamp: CLK }),
  JSON.stringify({ type: 'step_finish', part: {}, timestamp: CLK }),
].join('\n');

interface Recorder {
  events: { type: string; workers?: WorkerTask[] }[];
}

function makeRegistry(opts: {
  agyRoot: string;
  opencodeRoot: string;
  injectAlive?: boolean;
  link?: RegistryLinkFn;
}) {
  const recorder: Recorder = { events: [] };
  const registry = new WorkerRegistry({
    emit: e => recorder.events.push(e),
    agyRoot: opts.agyRoot,
    opencodeRoot: opts.opencodeRoot,
    ...(opts.injectAlive === false ? {} : { isAlive }),
    ...(opts.link ? { link: opts.link } : {}),
  });
  return { registry, recorder };
}

type RegistryLinkFn = (lane: 'agy' | 'opencode', slug: string) => { sessionId: string; nodeId: string } | undefined;

describe('WorkerRegistry', () => {
  let agyRoot: string;
  let opencodeRoot: string;
  let env: ReturnType<typeof makeRegistry>;

  beforeAll(async () => {
    agyRoot = await mkdtemp(join(tmpdir(), 'fleet-registry-agy-'));
    opencodeRoot = await mkdtemp(join(tmpdir(), 'fleet-registry-oc-'));

    // Running opencode task with a live pid, opts.json and a JSON log with denied calls.
    await mkdir(join(opencodeRoot, 'repo-a', 'w1'), { recursive: true });
    await writeFile(join(opencodeRoot, 'repo-a', 'w1', 'pid'), String(LIVE_PID));
    await writeFile(join(opencodeRoot, 'repo-a', 'w1', 'base'), 'c0ffee');
    await writeFile(join(opencodeRoot, 'repo-a', 'w1', 'opts.json'), JSON.stringify({ model: 'opencode-go/glm-5.3-flash', effort: 'high', agent: 'backend-specialist' }));
    await writeFile(join(opencodeRoot, 'repo-a', 'w1', 'opencode.log'), OPENCODE_LOG);

    // Finished agy task: ok, wall_s, model, one denied action.
    await mkdir(join(agyRoot, 'repo-b', 'done1'), { recursive: true });
    await writeFile(join(agyRoot, 'repo-b', 'done1', 'pid'), String(LIVE_PID + 1));
    await writeFile(join(agyRoot, 'repo-b', 'done1', 'base'), 'beef01');
    await writeFile(join(agyRoot, 'repo-b', 'done1', 'result.json'), JSON.stringify({
      ok: true, model: 'gemini-3.8-flash', wall_s: 42, branch: 'agy/done1',
      changes: '2 files changed', denied_actions: ['cat .env'], warnings: [], response: 'All done.',
    }));

    // Finished and NOT ok (circuit breaker).
    await mkdir(join(agyRoot, 'repo-b', 'failed1'), { recursive: true });
    await writeFile(join(agyRoot, 'repo-b', 'failed1', 'pid'), String(LIVE_PID + 2));
    await writeFile(join(agyRoot, 'repo-b', 'failed1', 'result.json'), JSON.stringify({ ok: false, stopped_by: 'max-denied', wall_s: 5 }));

    // Unfinished: a pid file whose process is dead (recycled pid check), no result.
    await mkdir(join(agyRoot, 'repo-b', 'noresult'), { recursive: true });
    await writeFile(join(agyRoot, 'repo-b', 'noresult', 'pid'), String(LIVE_PID + 3));
    await writeFile(join(agyRoot, 'repo-b', 'noresult', 'base'), 'feed01');

    env = makeRegistry({
      agyRoot,
      opencodeRoot,
      link: (lane, slug) => (slug === 'w1' ? { sessionId: 'sess1', nodeId: 'node1' } : undefined),
    });
  });

  afterAll(async () => {
    await rm(agyRoot, { recursive: true, force: true });
    await rm(opencodeRoot, { recursive: true, force: true });
  });

  it('scans states, orders running first and links the tree node', async () => {
    const { registry, recorder } = env;
    await registry.scanNow();
    const workers = registry.list();
    expect(workers).toHaveLength(4);
    expect(workers[0]!.state).toBe('running');

    const running = workers[0]!;
    expect(running.lane).toBe('opencode');
    expect(running.repo).toBe('repo-a');
    expect(running.slug).toBe('w1');
    expect(running.model).toBe('opencode-go/glm-5.3-flash');
    expect(running.effort).toBe('high');
    expect(running.agent).toBe('backend-specialist');
    expect(running.startedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(running.endedAt).toBeUndefined();
    expect(running.elapsedS).toBeLessThan(60);
    expect(running.denied).toBe(2); // the rule + permission refusals; the connection refusal is not one
    expect(running.toolCounts).toEqual({ bash: 2, edit: 2 });
    expect(running.lastTool).toBe('edit src/app.ts');
    expect(running.sessionId).toBe('sess1');
    expect(running.nodeId).toBe('node1');

    const ok = workers.find(w => w.slug === 'done1')!;
    expect(ok.state).toBe('ok');
    expect(ok.lane).toBe('agy');
    expect(ok.model).toBe('gemini-3.8-flash');
    expect(ok.elapsedS).toBe(42);
    expect(ok.endedAt).toBeDefined();
    expect(ok.denied).toBe(1);
    expect(ok.branch).toBe('agy/done1');
    expect(ok.changes).toBe('2 files changed');
    expect(ok.response).toBe('All done.');
    expect(ok.sessionId).toBeUndefined();

    const failed = workers.find(w => w.slug === 'failed1')!;
    expect(failed.state).toBe('not-ok');
    expect(failed.stoppedBy).toBe('max-denied');

    const unfinished = workers.find(w => w.slug === 'noresult')!;
    expect(unfinished.state).toBe('unfinished');
    expect(unfinished.denied).toBe(0);

    expect(workers.slice(1).every(w => w.state !== 'running')).toBe(true);

    // Exactly one workers.update was emitted (only when the list changed).
    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]!.workers?.map(w => w.slug)).toEqual(workers.map(w => w.slug));
    await registry.scanNow();
    expect(recorder.events).toHaveLength(1); // unchanged list: no second event
  });

  it('re-emits when the state changes', async () => {
    const { registry, recorder } = env;
    await writeFile(join(agyRoot, 'repo-b', 'noresult', 'result.json'), JSON.stringify({ ok: true, wall_s: 3 }));
    await registry.scanNow();
    expect(recorder.events).toHaveLength(2);
    expect(registry.list().find(w => w.slug === 'noresult')?.state).toBe('ok');
  });

  describe('log()', () => {
    it('renders opencode JSON events as readable lines and passes stderr through', async () => {
      const { registry } = env;
      const lines = await registry.log('opencode', 'repo-a', 'w1');
      expect(lines).toBeDefined();
      expect(lines!.some(l => l.startsWith('opencode-task ► w1'))).toBe(true); // stderr banner
      expect(lines!.some(l => l.includes('text: On it. Running the tests now.'))).toBe(true);
      expect(lines!.some(l => l.includes('tool bash npm test running'))).toBe(true);
      expect(lines!.some(l => l.includes('tool bash rm -rf / error'))).toBe(true);
      expect(lines!.some(l => l.includes('tool edit src/app.ts error'))).toBe(true);
      expect(lines!.some(l => l.includes('step finish'))).toBe(true);
      // Every rendered JSON event line starts with HH:MM:SS; while the cwd is not a requirement.
      expect(lines!.every(l => /^\d{2}:\d{2}:\d{2} /.test(l) || !l.startsWith('{'))).toBe(true);
    });

    it('validates lane and names and refuses escaping the lane root', async () => {
      const { registry } = env;
      await writeFile(join(agyRoot, 'repo-b', 'done1', 'agy.log'), 'banner line\nwork log line\n');
      expect(await registry.log('bad-lane', 'repo-a', 'w1')).toBeUndefined();
      expect(await registry.log('opencode', '..', 'w1')).toBeUndefined();
      expect(await registry.log('opencode', 'repo-a', '../done1')).toBeUndefined();
      expect(await registry.log('agy', 'repo-b/x', 'done1')).toBeUndefined();
      expect(await registry.log('opencode', 'repo-a', 'missing')).toBeUndefined();
      // agy logs are passed through as raw lines.
      const agyLines = await registry.log('agy', 'repo-b', 'done1');
      expect(agyLines).toEqual(['banner line', 'work log line']);
    });

    it('rejects symlinked repos and symlinked log files', async () => {
      const { registry } = env;
      // A repo entry that is a symlink to a directory outside the lane root.
      const outside = await mkdtemp(join(tmpdir(), 'fleet-out-'));
      try {
        await mkdir(join(outside, 'w2'), { recursive: true });
        await writeFile(join(outside, 'w2', 'opencode.log'), JSON.stringify({ type: 'text', part: { text: 'sneak' }, timestamp: CLK }));
        await symlink(join(outside), join(opencodeRoot, 'repo-sym'), 'dir');
        expect(await registry.log('opencode', 'repo-sym', 'w2')).toBeUndefined();
        // A symlinked log file inside a plain repo dir.
        await mkdir(join(opencodeRoot, 'repo-fsln', 'w3'), { recursive: true });
        await symlink(join(outside, 'w2', 'opencode.log'), join(opencodeRoot, 'repo-fsln', 'w3', 'opencode.log'), 'file');
        expect(await registry.log('opencode', 'repo-fsln', 'w3')).toBeUndefined();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('incremental opencode.log cache', () => {
    it('re-reads growth and shrink without re-parsing everything each poll', async () => {
      const { registry, recorder } = env;
      const logPath = join(opencodeRoot, 'repo-a', 'w1', 'opencode.log');
      const before = recorder.events.length;
      await registry.scanNow(); // poll 1 (baseline, unchanged)
      expect(recorder.events.length).toBe(before); // no change, no emit

      // Growth: an appended denied bash call changes denied/lastTool -> the list moves.
      await appendFile(logPath, '\n' + JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'error', error: 'a rule which prevents it', input: { command: 'curl evil' } } }, timestamp: CLK }) + '\n');
      await registry.scanNow();
      const grown = registry.list().find(w => w.slug === 'w1')!;
      expect(grown.denied).toBe(3); // 2 initial + 1 appended
      expect(grown.lastTool).toBe('bash curl evil');
      expect(recorder.events.length).toBe(before + 1);

      // Unchanged size/mtime: cached values are reused, nothing happens.
      const deniedBefore = registry.list().find(w => w.slug === 'w1')!.denied;
      await registry.scanNow();
      expect(registry.list().find(w => w.slug === 'w1')!.denied).toBe(deniedBefore);
      expect(recorder.events.length).toBe(before + 1);

      // Shrink: a rewritten smaller log resets the counts from scratch.
      await writeFile(logPath, JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'running', input: { filePath: 'x.ts' } } }, timestamp: CLK }));
      await registry.scanNow();
      const shrunk = registry.list().find(w => w.slug === 'w1')!;
      expect(shrunk.denied).toBe(0); // recomputed, not imported from the larger past
      expect(shrunk.lastTool).toBe('edit x.ts');
      expect(shrunk.toolCounts).toEqual({ edit: 1 });
      expect(recorder.events.length).toBe(before + 2);
    });
  });
});
