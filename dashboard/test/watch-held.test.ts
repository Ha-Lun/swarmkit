import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TranscriptWatcher } from '../server/watch/transcripts.ts';
import type { ServerEvent } from '../src/shared/types.ts';

const T1 = '2025-01-01T10:00:00.000Z';
const T2 = '2025-01-01T10:00:05.000Z';

const userLine = JSON.stringify({
  type: 'user',
  uuid: 'u1',
  timestamp: T1,
  cwd: '/repo/oldheld',
  message: { role: 'user', content: 'Old held session prompt' },
});
const assistantLine = JSON.stringify({
  type: 'assistant',
  uuid: 'a1',
  timestamp: T2,
  message: {
    id: 'm1',
    model: 'claude-opus-4-5',
    content: [{ type: 'text', text: 'Held reply.' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  },
});

describe('TranscriptWatcher held sessions', () => {
  let base: string;
  let projectsDir: string;
  let sessionsDir: string;
  let holderFile: string;
  let oldFile: string;
  let events: ServerEvent[];
  let watcher: TranscriptWatcher;
  let prevConfigDir: string | undefined;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'fleet-watch-held-'));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = base;
    projectsDir = path.join(base, 'projects');
    sessionsDir = path.join(base, 'sessions');
    await mkdir(path.join(projectsDir, 'proj-old'), { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    // A transcript outside the 14-day listing window (mtime set below), held by a live claude.
    oldFile = path.join(projectsDir, 'proj-old', 'old-held-id.jsonl');
    await writeFile(oldFile, `${userLine}\n${assistantLine}\n`);
    const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    await utimes(oldFile, old, old);
    holderFile = path.join(sessionsDir, `${process.pid}.json`);
    await writeFile(holderFile, JSON.stringify({
      pid: process.pid, // alive via the default probe
      sessionId: 'old-held-id',
      cwd: '/repo/oldheld',
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'idle',
      tmux: 'desk:@6.%5',
    }));

    events = [];
    watcher = new TranscriptWatcher({
      root: projectsDir,
      emit: (e) => events.push(e),
      skip: () => false,
      maxAgeMs: 14 * 24 * 60 * 60_000,
    });
  });

  afterAll(async () => {
    watcher.stop();
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    rmSync(base, { recursive: true, force: true });
  });

  it('populates the holders before list() and lists held sessions outside the window', async () => {
    await watcher.scanNow();
    const list = watcher.list();
    const held = list.find(s => s.id === 'old-held-id');
    expect(held).toBeDefined();
    expect(held!.status).toBe('idle'); // a live idle holder decides the status
    expect(held!.title).toBe('Old held session prompt');
    expect(held!.project).toBe('oldheld');
    expect(held!.terminal).toEqual({ pane: true, busy: false });
  });

  it('skips a holder whose transcript does not exist yet', async () => {
    await writeFile(path.join(sessionsDir, 'fresh.json'), JSON.stringify({
      pid: process.pid,
      sessionId: 'no-transcript',
      kind: 'interactive',
      status: 'idle',
    }));
    await watcher.scanNow();
    expect(watcher.list().find(s => s.id === 'no-transcript')).toBeUndefined();
  });

  it('emits a session.upsert when a holder appears and again when it disappears', async () => {
    const upsertsFor = (id: string) =>
      events.filter((e): e is Extract<ServerEvent, { type: 'session.upsert' }> =>
        e.type === 'session.upsert' && e.session.id === id);
    // The holder is present from beforeAll: the first scan emitted the "appeared" upsert
    // and list() shows the held summary with its terminal marker.
    const appeared = upsertsFor('old-held-id');
    expect(appeared.length).toBeGreaterThanOrEqual(1);
    const before = appeared[appeared.length - 1]!.session;
    expect(before.status).toBe('idle');
    expect(before.terminal).toEqual({ pane: true, busy: false });

    // The claude process exits: the holder file goes away. The very next scan must
    // tell the clients (the tab would otherwise stick at idle forever).
    await rm(holderFile);
    events.length = 0;
    await watcher.scanNow();
    const upserts = upsertsFor('old-held-id');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const after = upserts[upserts.length - 1]!.session;
    expect(after.status).toBe('done'); // old mtime, no holder: the session ended
    expect(after.terminal).toBeUndefined();
    // Gone from the listing again: outside the window and no longer held.
    expect(watcher.list().find(s => s.id === 'old-held-id')).toBeUndefined();
  });
});
