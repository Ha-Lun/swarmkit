import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRemoteControls, nameFrom } from '../server/remotecontrol.ts';

const S = '\u001f';
const row = (...f: string[]) => f.join(S);

function fakeTmux(panes: string[], captures: Record<string, string>) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'list-panes') return panes.join('\n') + '\n';
    if (args[0] === 'capture-pane') return captures[args[args.length - 1]!] ?? '';
    return '';
  };
  return { exec, calls };
}

const panes = [
  row('%0', 'claude-rc', '0', 'shell', '0', 'bash', '/tmp', '1793439717'),
  row('%2', 'claude-rc', '2', 'milknet', '0', '"claude remote-control --spawn same-dir --name milknet"', '/home/x/projects/milknet', '1793464203'),
  row('%5', 'claude-rc', '5', 'wine', '1', '"claude remote-control --spawn same-dir --name wine-cellar-app"', '/home/x/projects/wine', '1793464203'),
  row('%6', 'claude-rc', '6', 'server-admin', '0', '"claude rc --name Server-Admin"', '/', '1793623062'),
  row('%9', 'other', '1', 'vim', '0', 'vim notes-about-claude-rc.md', '/tmp', '1'),
];

/** A sessions dir with a live session file for pane %6 and a stale one for %2. */
function sessionsDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rc-sessions-'));
  writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, tmux: 'claude-rc:@6.%6', sessionId: '8bb5de59-103b-443e-8cbf-86547e16eb8f' }));
  writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: 2 ** 30, tmux: 'claude-rc:@2.%2', sessionId: '00000000-0000-0000-0000-000000000000' }));
  writeFileSync(path.join(dir, '3.json'), '{not json');
  return dir;
}
const captures = {
  '%2': 'Capacity: 0/32\nhttps://claude.ai/code?environment=env_old\n·✔︎· Connected\nCapacity: 2/32 · New sessions\nContinue at https://claude.ai/code?environment=env_018Edx',
  '%5': 'https://claude.ai/code?environment=env_dead\nPane is dead',
};

describe('remote-control panes', () => {
  it('parses --name in its quoted forms', () => {
    expect(nameFrom('"claude rc --name Server-Admin"')).toBe('Server-Admin');
    expect(nameFrom("claude remote-control --name='my game'")).toBe('my game');
    expect(nameFrom('claude rc')).toBeUndefined();
  });

  it('lists only live claude remote-control panes, with the latest capacity and their session', async () => {
    const { exec, calls } = fakeTmux(panes, captures);
    const list = await createRemoteControls({ exec, ttlMs: 0, sessionsDir: sessionsDir() }).list();
    expect(list.map((r) => r.name)).toEqual(['milknet', 'Server-Admin']);
    expect(list[0]).toMatchObject({ id: '2', sessions: 2, capacity: 32, target: 'claude-rc:2' });
    expect(list[0]!.sessionId).toBeUndefined(); // only a stale session file points at %2
    expect(list[1]).toMatchObject({ id: '6', sessionId: '8bb5de59-103b-443e-8cbf-86547e16eb8f' });
    expect(list[1]!.sessions).toBeUndefined();
    expect(calls.some((c) => c[0] === 'capture-pane' && c.includes('%5'))).toBe(false);
  });

  it('returns an empty list when tmux is not running', async () => {
    const rc = createRemoteControls({ exec: async () => { throw new Error('no server'); }, ttlMs: 0, sessionsDir: sessionsDir() });
    expect(await rc.list()).toEqual([]);
  });
});
