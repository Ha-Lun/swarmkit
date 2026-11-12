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
  row('%0', 'claude-rc', '0', 'shell', '0', '', 'bash', '/tmp', '1793439717'),
  row('%2', 'claude-rc', '2', 'milknet', '0', '', '"claude remote-control --spawn same-dir --name milknet"', '/home/x/projects/milknet', '1793464203'),
  row('%5', 'claude-rc', '5', 'wine', '1', '1793464204', '"claude remote-control --spawn same-dir --name wine-cellar-app"', '/home/x/projects/wine', '1793464203'),
  row('%6', 'claude-rc', '6', 'server-admin', '0', '', '"claude rc --name Server-Admin"', '/', '1793623062'),
  row('%9', 'other', '1', 'vim', '0', '', 'vim notes-about-claude-rc.md', '/tmp', '1'),
];
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

  it('lists only claude remote-control panes, live first, with the latest capacity and URL', async () => {
    const { exec } = fakeTmux(panes, captures);
    const list = await createRemoteControls({ exec, ttlMs: 0 }).list();
    expect(list.map((r) => r.name)).toEqual(['milknet', 'Server-Admin', 'wine-cellar-app']);
    expect(list[0]).toMatchObject({ id: '2', alive: true, sessions: 2, capacity: 32, url: 'https://claude.ai/code?environment=env_018Edx', target: 'claude-rc:2' });
    expect(list[2]).toMatchObject({ id: '5', alive: false, stoppedAt: 1793464204000 });
    expect(list[2]!.sessions).toBeUndefined();
  });

  it('restarts only a stopped pane, without -k', async () => {
    const { exec, calls } = fakeTmux(panes, captures);
    const rc = createRemoteControls({ exec, ttlMs: 0 });
    expect(await rc.restart('2')).toBe(false); // live
    expect(await rc.restart('0')).toBe(false); // not a remote-control pane
    expect(await rc.restart('%5')).toBe(false); // bad id shape
    expect(calls.some((c) => c[0] === 'respawn-pane')).toBe(false);
    expect(await rc.restart('5')).toBe(true);
    expect(calls.filter((c) => c[0] === 'respawn-pane')).toEqual([['respawn-pane', '-t', '%5']]);
  });

  it('returns an empty list when tmux is not running', async () => {
    const rc = createRemoteControls({ exec: async () => { throw new Error('no server'); }, ttlMs: 0 });
    expect(await rc.list()).toEqual([]);
  });
});
