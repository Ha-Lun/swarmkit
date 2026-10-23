import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptWatcher } from '../server/watch/transcripts.ts';
import type { ServerEvent } from '../src/shared/types.ts';

const T1 = '2025-01-01T10:00:00.000Z';
const T2 = '2025-01-01T10:00:05.000Z';

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

  it('exposes recentCwds newest first and survives start()/stop()', async () => {
    const cwds = watcher.recentCwds();
    expect(cwds).toContain('/repo/alpha');
    expect(cwds[0]).toBe('/repo/alpha');
    const before = watcher.list().length;
    watcher.start();
    watcher.stop();
    expect(watcher.list().length).toBeGreaterThanOrEqual(before);
  });
});
