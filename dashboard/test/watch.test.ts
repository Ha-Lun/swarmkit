import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../server/watch/transcripts.ts';
import type { ServerEvent } from '../src/shared/types.ts';

const T1 = '2025-01-01T10:00:00.000Z';
const T2 = '2025-01-01T10:00:05.000Z';

/** Test-only view of the watcher internals (live map). */
function liveOf(w: TranscriptWatcher): Map<string, { lastAccess: number; mtimeMs: number; path: string }> {
  return (w as unknown as { live: Map<string, { lastAccess: number; mtimeMs: number; path: string }> }).live;
}

const PAD_LINE = 'x'.repeat(400); // a non-JSON padding line for the large-file fixture

const userLine = JSON.stringify({
  type: 'user',
  uuid: 'u1',
  timestamp: T1,
  cwd: '/repo/alpha',
  message: { role: 'user', content: 'Fix the fleet overlays' },
});
const baseAssistant = JSON.stringify({
  type: 'assistant',
  uuid: 'a1',
  timestamp: T2,
  message: {
    id: 'm1',
    model: 'claude-opus-4-5',
    content: [{ type: 'text', text: 'Working on overlays.' }],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const appended = JSON.stringify({
  type: 'assistant',
  uuid: 'a2',
  timestamp: '2025-01-01T10:01:00.000Z',
  message: {
    id: 'm2',
    model: 'claude-opus-4-5',
    content: [{ type: 'text', text: 'Overlays are aligned now.' }],
    usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const skippedAssistant = JSON.stringify({
  type: 'assistant',
  uuid: 'a9',
  timestamp: T2,
  message: {
    id: 'm9',
    model: 'claude-opus-4-5',
    content: [{ type: 'text', text: 'skip-me text' }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});

const skipLine = JSON.stringify({
  type: 'user',
  uuid: 'v1',
  timestamp: T1,
  cwd: '/repo/secret',
  message: { role: 'user', content: 'Hidden session' },
});

function eventKinds(events: ServerEvent[]): string[] {
  return events.filter((e) => e.type === 'node.event').map((e) => (e as { event: { kind: string } }).event.kind);
}

function nodeIdsOf(events: ServerEvent[]): string[] {
  return events
    .filter((e) => e.type === 'node.upsert')
    .map((e) => (e as { node: { id: string } }).node.id);
}

describe('TranscriptWatcher', () => {
  let root: string;
  let projectDir: string;
  let sessionFile: string;
  let seen: ServerEvent[];
  let watcher: TranscriptWatcher;

  beforeAll(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'fleet-watch-')), 'projects');
    projectDir = join(root, 'proj-alpha');
    await mkdir(projectDir, { recursive: true });
    sessionFile = join(projectDir, 'sess1.jsonl');
    await writeFile(sessionFile, `${userLine}\n${baseAssistant}\n`);

    seen = [];
    watcher = new TranscriptWatcher({
      root,
      emit: (e) => seen.push(e),
      skip: (id) => id.startsWith('skip'),
      maxAgeMs: 10 * 60_000,
    });
  });

  afterAll(async () => {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  });

  it('lists a fresh session with project and title', () => {
    const sessions = watcher.list();
    const found = sessions.find((s) => s.id === 'sess1');
    expect(found).toBeDefined();
    expect(found!.source).toBe('terminal');
    expect(found!.project).toBe('alpha'); // basename of cwd /repo/alpha
    expect(found!.title).toBe('Fix the fleet overlays');
    expect(found!.status).toBe('running'); // file modified just now
    expect(found!.pendingPermissions).toBe(0);
  });

  it('parses the session fully on get()', async () => {
    const detail = await watcher.get('sess1');
    expect(detail).toBeDefined();
    expect(detail!.nodes.map((n) => n.id)).toContain('root');
    const rootNode = detail!.nodes.find((n) => n.id === 'root')!;
    expect(rootNode.result).toBe('Working on overlays.');
    expect(rootNode.events.some((e) => e.kind === 'user')).toBe(true);
    expect(detail!.permissions).toEqual([]);
    // The parse produced activity events and a session.upsert.
    expect(eventKinds(seen)).toContain('user');
    expect(seen.some((e) => e.type === 'session.upsert' && (e as { session: { id: string } }).session.id === 'sess1')).toBe(true);
  });

  it('reflects an appended line delivered in two chunks (partial line buffering)', async () => {
    const before = (await watcher.get('sess1'))!.nodes.find((n) => n.id === 'root')!;
    const eventsBefore = before.events.length;
    const nodesBefore = nodeIdsOf(seen).length;

    // First chunk: a partial line without a trailing newline must not be parsed.
    await appendFile(sessionFile, appended.slice(0, 60));
    await watcher.scanNow();
    const mid = (await watcher.get('sess1'))!.nodes.find((n) => n.id === 'root')!;
    expect(mid.result).toBe(before.result);
    expect(nodeIdsOf(seen).length).toBeLessThanOrEqual(nodesBefore + 2); // at most a no-op refresh
    // Second chunk completes the line; the next scan applies it.
    await appendFile(sessionFile, appended.slice(60) + '\n');
    await watcher.scanNow();
    const after = (await watcher.get('sess1'))!.nodes.find((n) => n.id === 'root')!;
    expect(after.result).toBe('Overlays are aligned now.');
    expect(eventKinds(seen)).toContain('text');
    expect(after.events.length).toBeGreaterThan(eventsBefore);
  });

  it('hides skipped sessions', async () => {
    const skippedDir = join(root, 'proj-beta');
    await mkdir(skippedDir, { recursive: true });
    const file = join(skippedDir, 'skipme.jsonl');
    await writeFile(file, `${skipLine}\n${skippedAssistant}\n`);
    await watcher.scanNow();
    expect(watcher.list().some((s) => s.id === 'skipme')).toBe(false);
    expect(await watcher.get('skipme')).toBeUndefined();
  });

  it('exposes recentCwds newest first and survives start()/stop()', () => {
    const cwds = watcher.recentCwds();
    expect(cwds).toContain('/repo/alpha');
    expect(cwds[0]).toBe('/repo/alpha');
    const before = watcher.list().length;
    watcher.start();
    watcher.stop();
    expect(watcher.list().length).toBeGreaterThanOrEqual(before);
  });

  // --- findings -----------------------------------------------------------

  it('keeps the partial last line of the initial full parse for the next tail', async () => {
    // File on disk ends mid-line, without a trailing newline.
    const temp = join(await mkdtemp(join(tmpdir(), 'fleet-watch2-')), 'projects');
    const dir = join(temp, 'p');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'part.jsonl');
    await writeFile(file, `${userLine}\n${appended.slice(0, 30)}`); // partial line, no '\n'
    const w = new TranscriptWatcher({ root: temp, emit: (e) => seen.push(e), skip: () => false });
    try {
      const detail = await w.get('part');
      const root0 = detail!.nodes.find((n) => n.id === 'root')!;
      expect(root0.result).toBeUndefined(); // the partial line could not be parsed yet
      expect(root0.description).toBe('Fix the fleet overlays');
      await appendFile(file, appended.slice(30) + '\n');
      await w.scanNow();
      const after = (await w.get('part'))!.nodes.find((n) => n.id === 'root')!;
      expect(after.result).toBe('Overlays are aligned now.'); // the completed line was applied
    } finally {
      w.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('detects truncation/rewrite: rebuilds the tree and emits node.upserts + session.upsert', async () => {
    const temp = join(await mkdtemp(join(tmpdir(), 'fleet-watch3-')), 'projects');
    const dir = join(temp, 'p');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'trunc.jsonl');
    await writeFile(file, `${userLine}\n${baseAssistant}\n`);
    const w = new TranscriptWatcher({ root: temp, emit: (e) => seen.push(e), skip: () => false });
    try {
      await w.get('trunc');
      const eventsBefore = seen.length;
      // Truncated + rewritten from scratch.
      const rewritten = JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: T1,
        cwd: '/repo/alpha',
        message: { role: 'user', content: 'Rebuilt session content' },
      });
      await writeFile(file, `${rewritten}\n${skippedAssistant}\n`);
      await w.scanNow();
      const ups = nodeIdsOf(seen.slice(eventsBefore));
      expect(ups).toContain('root'); // node.upsert for every node
      expect(seen.slice(eventsBefore).some((e) => e.type === 'session.upsert' && (e as { session: { id: string } }).session.id === 'trunc')).toBe(true);
      // The rebuilt tree reflects the rewritten content, not stale state.
      const after = (await w.get('trunc'))!.nodes.find((n) => n.id === 'root')!;
      expect(after.result).toBe('skip-me text');
      expect(after.prompt).toBe('Rebuilt session content');
    } finally {
      w.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('evicts stale live sessions with a final session.upsert and keeps the live cap at 20', async () => {
    const temp = join(await mkdtemp(join(tmpdir(), 'fleet-watch4-')), 'projects');
    const dir = join(temp, 'p');
    await mkdir(dir, { recursive: true });
    const w = new TranscriptWatcher({ root: temp, emit: (e) => seen.push(e), skip: () => false });
    try {
      // One session that gets stale: parsed, then aged out (old mtime, last access 12 min ago).
      const staleFile = join(dir, 'stale.jsonl');
      await writeFile(staleFile, `${userLine}\n${baseAssistant}\n`);
      const past = Date.now() - 20 * 60_000;
      await utimes(staleFile, past / 1000, past / 1000);
      await w.get('stale');
      expect(liveOf(w).size).toBe(1);
      const live = liveOf(w).get('stale')!;
      live.lastAccess = Date.now() - 12 * 60_000;
      // Plus 22 fresh files: the cap (20) must keep the live map bounded.
      for (let i = 1; i <= 22; i++) {
        const f = join(dir, `fresh${i}.jsonl`);
        await writeFile(f, `${userLine}\n${baseAssistant}\n`);
      }
      for (let tick = 0; tick < 14; tick++) {
        await w.scanNow();
        expect(liveOf(w).size).toBeLessThanOrEqual(20);
      }
      expect(liveOf(w).has('stale')).toBe(false); // evicted
      const lastUps = seen.map((e) => (e as { type: string; session?: { id: string } })).filter(
        (e) => e.type === 'session.upsert' && e.session?.id === 'stale',
      );
      expect(lastUps.length).toBeGreaterThan(0); // final session.upsert with the head state
      // get() can still re-load an evicted session on demand.
      expect(await w.get('stale')).toBeDefined();
    } finally {
      w.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('deletes live sessions whose skipFn turns true during the tail loop', async () => {
    const temp = join(await mkdtemp(join(tmpdir(), 'fleet-watch5-')), 'projects');
    const dir = join(temp, 'p');
    await mkdir(dir, { recursive: true });
    let skipNow = false;
    const skip = (): boolean => skipNow;
    const w = new TranscriptWatcher({ root: temp, emit: (e) => seen.push(e), skip });
    try {
      await writeFile(join(dir, 'dyn.jsonl'), `${userLine}\n${baseAssistant}\n`);
      await w.get('dyn');
      expect(liveOf(w).size).toBe(1);
      skipNow = true;
      await w.scanNow();
      expect(liveOf(w).size).toBe(0); // deleted in the live loop
      skipNow = false;
    } finally {
      w.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('parses only the tail of a file larger than 4 MB and keeps the head title', async () => {
    const temp = join(await mkdtemp(join(tmpdir(), 'fleet-watch6-')), 'projects');
    const dir = join(temp, 'p');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'big.jsonl');
    const tailLine = JSON.stringify({
      type: 'assistant',
      uuid: 'a99',
      timestamp: '2025-01-01T10:30:00.000Z',
      message: {
        id: 'm99',
        model: 'claude-opus-4-5',
        content: [{ type: 'text', text: 'End of the big session.' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    });
    const bigFirst = JSON.stringify({
      type: 'user',
      uuid: 'u0',
      timestamp: T1,
      cwd: '/repo/alpha',
      message: { role: 'user', content: 'Big session: budget check' },
    });
    // A much later user prompt lives inside the parsed tail: the head title must win.
    const tailUser = JSON.stringify({
      type: 'user',
      uuid: 'u5',
      timestamp: T2,
      message: { role: 'user', content: 'Tail prompt: late follow-up' },
    });
    const padding = Array.from({ length: 12_000 }, () => PAD_LINE).join('\n') + '\n'; // ~5 MB
    await writeFile(file, `${bigFirst}\n${padding}${tailUser}\n${tailLine}\n`);
    const w = new TranscriptWatcher({ root: temp, emit: (e) => seen.push(e), skip: () => false });
    try {
      const summary = w.list().find((s) => s.id === 'big')!;
      expect(summary.title).toBe('Big session: budget check'); // head read, no full parse needed
      const detail = await w.get('big');
      expect(detail!.title).toBe('Big session: budget check'); // preserved despite tail-only tree
      // The head's first prompt wins over the tail's later user prompt everywhere.
      expect(detail!.title).not.toBe('Tail prompt: late follow-up');
      const root = detail!.nodes.find((n) => n.id === 'root')!;
      expect(root.description).toBe('Big session: budget check');
      expect(root.prompt).toBe('Big session: budget check');
      expect(root.lastActivity).toBe('End of the big session.'); // activity follows the latest tail message
      expect(detail!.nodes.some((n) => n.id === 'root')).toBe(true);
      expect(detail!.nodes.find((n) => n.id === 'root')!.result).toBe('End of the big session.');
      // Broadcast summaries carry the head title too, not the tail prompt.
      const upserts = seen.filter(
        (e) => e.type === 'session.upsert' && (e as { session?: { id?: string; title?: string } }).session?.id === 'big',
      );
      expect(upserts.length).toBeGreaterThan(0);
      expect(upserts.every((e) => (e as { session?: { title?: string } }).session?.title === 'Big session: budget check')).toBe(true);
      // The early padding was not converted into thousands of events.
      const emitted = seen.filter((e) => e.type === 'node.event' && (e as { sessionId?: string }).sessionId === 'big').length;
      expect(emitted).toBeLessThan(50);
    } finally {
      w.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });
});

describe('TranscriptWatcher: terminal status from the live-session registry', () => {
  type TreePeek = Map<string, { tree: { nodes: Map<string, { status: string }> } }>;

  /** Read-only view on the watcher's live map trees. */
  function treesOf(w: TranscriptWatcher): TreePeek {
    return (w as unknown as { live: TreePeek }).live;
  }

  const holderRecord = (sessionId: string, status: string): string =>
    JSON.stringify({
      pid: process.pid, // this process is alive, so the default probe reports it
      sessionId,
      cwd: '/repo/holder',
      kind: 'interactive',
      entrypoint: 'cli',
      status,
    });

  /** A temp CLAUDE_CONFIG_DIR (sessions/) + projects root, and a watcher for it. */
  async function setup(): Promise<{
    temp: string;
    projects: string;
    sessionsDir: string;
    seen: ServerEvent[];
    watcher: TranscriptWatcher;
  }> {
    const temp = await mkdtemp(join(tmpdir(), 'fleet-liveholder-'));
    const projects = join(temp, 'projects');
    const sessionsDir = join(temp, 'sessions');
    await mkdir(projects, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    const seen: ServerEvent[] = [];
    const watcher = new TranscriptWatcher({ root: projects, emit: (e) => seen.push(e), skip: () => false });
    return { temp, projects, sessionsDir, seen, watcher };
  }

  async function withConfigDir(temp: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = temp;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  }

  it('a live holder decides the status: busy -> running, idle -> idle', async () => {
    const { temp, projects, sessionsDir, watcher } = await setup();
    try {
      // Both transcripts are long past the mtime cap: without holders they would be done.
      await mkdir(join(projects, 'p'), { recursive: true });
      await writeFile(join(projects, 'p', 'busy-held.jsonl'), `${userLine}\n${baseAssistant}\n`);
      await writeFile(join(projects, 'p', 'idle-held.jsonl'), `${userLine}\n${baseAssistant}\n`);
      const past = Date.now() - 10 * 60_000;
      await utimes(join(projects, 'p', 'busy-held.jsonl'), past / 1000, past / 1000);
      await utimes(join(projects, 'p', 'idle-held.jsonl'), past / 1000, past / 1000);
      await writeFile(join(sessionsDir, `${process.pid}.json`), holderRecord('busy-held', 'busy'));
      await writeFile(join(sessionsDir, `${process.pid}-second.json`), holderRecord('idle-held', 'idle'));
      await withConfigDir(temp, async () => {
        await watcher.scanNow(); // primes the holder snapshot
        const list = watcher.list();
        expect(list.find((s) => s.id === 'busy-held')!.status).toBe('running'); // busy beats the mtime cap
        expect(list.find((s) => s.id === 'idle-held')!.status).toBe('idle'); // idle holder, any mtime
      });
    } finally {
      watcher.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('without a holder the mtime cap applies: done after 30 s, running before', async () => {
    const { temp, projects, watcher, seen } = await setup();
    try {
      await mkdir(join(projects, 'p'), { recursive: true });
      await writeFile(join(projects, 'p', 'aged.jsonl'), `${userLine}\n${baseAssistant}\n`);
      await writeFile(join(projects, 'p', 'fresh.jsonl'), `${userLine}\n${baseAssistant}\n`);
      const past = Date.now() - 40_000;
      await utimes(join(projects, 'p', 'aged.jsonl'), past / 1000, past / 1000);
      await withConfigDir(temp, async () => {
        await watcher.scanNow();
        const list = watcher.list();
        expect(list.find((s) => s.id === 'aged')!.status).toBe('done'); // 40 s old, no holder
        expect(list.find((s) => s.id === 'fresh')!.status).toBe('running'); // written right now
        // The broadcast summaries agree with list().
        const upserts = seen.filter(
          (e) => e.type === 'session.upsert' &&
            ((e as { session?: { id?: string; status?: string } }).session?.id === 'aged'),
        );
        expect(upserts.every((e) => (e as { session?: { status?: string } }).session?.status === 'done')).toBe(true);
      });
    } finally {
      watcher.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('a waiting permission beats a busy holder', async () => {
    const { temp, projects, sessionsDir, watcher } = await setup();
    try {
      await mkdir(join(projects, 'p'), { recursive: true });
      await writeFile(join(projects, 'p', 'waitf.jsonl'), `${userLine}\n${baseAssistant}\n`);
      await writeFile(join(sessionsDir, `${process.pid}.json`), holderRecord('waitf', 'busy'));
      await withConfigDir(temp, async () => {
        await watcher.get('waitf');
        // Simulate a node blocked on a permission decision.
        const node = treesOf(watcher).get('waitf')!.tree.nodes.get('root')!;
        node.status = 'waiting';
        await watcher.scanNow();
        expect(watcher.list().find((s) => s.id === 'waitf')!.status).toBe('waiting');
      });
    } finally {
      watcher.stop();
      await rm(temp, { recursive: true, force: true });
    }
  });
});
