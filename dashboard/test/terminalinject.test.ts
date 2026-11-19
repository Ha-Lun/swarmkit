import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveHolder, liveHolders } from '../server/livesessions.ts';
import {
  COOLDOWN_MS,
  MAX_TERMINAL_TEXT,
  parseProcStat,
  sanitizeTerminalText,
  sendTerminalMessage,
  TerminalInjectError,
} from '../server/terminalinject.ts';
import type { TmuxExec } from '../server/terminalinject.ts';
import type { LiveHolder } from '../server/livesessions.ts';

const temps: string[] = [];
afterEach(() => {
  for (const base of temps.splice(0)) rmSync(base, { recursive: true, force: true });
});

/** /proc/<pid>/stat-shaped line: `pid (comm) state ppid pgrp session tty_nr tpgid …`. */
function statLine(pid: number, o: { comm?: string; state?: string; ppid?: number; pgrp?: number; tpgid?: number } = {}): string {
  const pgrp = o.pgrp ?? pid;
  return `${pid} (${o.comm ?? 'claude'}) ${o.state ?? 'S'} ${o.ppid ?? 1} ${pgrp} 42 999 ${o.tpgid ?? pgrp} 0 1 2 3`;
}

const HOLDER: LiveHolder = {
  pid: 4242,
  kind: 'interactive',
  status: 'idle',
  entrypoint: 'cli',
  tmux: '%3',
};

interface Call {
  args: string[];
  input?: string;
}

/** Fake tmux: records calls, answers display-message, optionally fails or hangs a call. */
function makeExec(opts: { paneInfo?: string; pasteFails?: boolean; hangAt?: string } = {}) {
  const calls: Call[] = [];
  let release: (value: string) => void = () => {};
  const exec: TmuxExec = (args, input) => {
    calls.push({ args, input });
    if (opts.hangAt === args[0]) {
      return new Promise<string>(resolve => {
        release = resolve;
      });
    }
    if (args[0] === 'display-message') return Promise.resolve(opts.paneInfo ?? `${3000} 0`);
    if (args[0] === 'paste-buffer' && opts.pasteFails) return Promise.reject(new Error('paste failed'));
    return Promise.resolve('');
  };
  return { calls, exec, release: (v: string) => release(v) };
}

/** The holder's whole process tree: pane 3000 -> 3500 -> holder 4242. */
const TREE: Record<number, string> = {
  3000: statLine(3000, { ppid: 1 }),
  3500: statLine(3500, { ppid: 3000 }),
  4242: statLine(4242, { ppid: 3500 }),
};

function treeReadStat(lines: Record<number, string> = TREE): (pid: number) => Promise<string> {
  return async (pid) => {
    const line = lines[pid];
    if (line === undefined) throw new TerminalInjectError('the terminal process is gone');
    return line;
  };
}

const baseOpts = (over: Record<string, unknown> = {}): Parameters<typeof sendTerminalMessage>[3] => ({
  exec: makeExec().exec,
  probe: () => {},
  readStat: treeReadStat(),
  readHolder: async () => undefined,
  enterDelayMs: 1,
  ...over,
});

describe('sanitizeTerminalText', () => {
  it('strips C0 controls except \\n and \\t, ESC and C1, and trims the start', () => {
    // NUL, ESC, BEL, backspace, CR, DEL and C1 are gone; newline, tab and text stay.
    const raw = '\u0000abc\u001bB\u0007def\n\tghi\r\u007f\u009c';
    expect(sanitizeTerminalText(raw)).toBe('abcBdef\n\tghi');
  });

  it('keeps newlines, tabs, unicode and every visible character', () => {
    expect(sanitizeTerminalText('café — “…” 😀\n\tok')).toBe('café — “…” 😀\n\tok');
    expect(sanitizeTerminalText('   \n  leading')).toBe('leading');
    expect(sanitizeTerminalText('')).toBe('');
  });
});

describe('parseProcStat', () => {
  it('parses fields after the last ) even when comm holds spaces and parentheses', () => {
    const line = statLine(1234, { comm: 'cla) ude (x', state: 'S', ppid: 55, pgrp: 1234, tpgid: 1234 });
    expect(parseProcStat(line)).toEqual({ state: 'S', ppid: 55, pgrp: 1234, tpgid: 1234 });
  });

  it('reads a stopped state and a foreign foreground group', () => {
    expect(parseProcStat(statLine(9, { state: 'T' })).state).toBe('T');
    const fg = parseProcStat(statLine(9, { pgrp: 9, tpgid: 777 }));
    expect(fg.pgrp).not.toBe(fg.tpgid);
  });
});

describe('LiveHolder pane normalization', () => {
  it('reduces the registry tmux target to the pane id', async () => {
    const base = mkdtempSync(path.join(homedir(), 'fleet-pane-test-'));
    temps.push(base);
    const dir = path.join(base, 'sessions');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ pid: 1, sessionId: 'pane-1', tmux: 'desk:@6.%6', kind: 'interactive', status: 'idle' }));
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ pid: 1, sessionId: 'pane-2', tmux: 'weird', kind: 'interactive' }));
    writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ pid: 1, sessionId: 'pane-3', kind: 'interactive' }));
    const holders = await liveHolders({ dir, isAlive: () => true });
    expect(holders.get('pane-1')?.tmux).toBe('%6');
    expect(holders.get('pane-2')?.tmux).toBeUndefined(); // no pane id in the target
    expect(holders.get('pane-3')?.tmux).toBeUndefined(); // no tmux field at all
    expect((await liveHolder('pane-1', { dir, isAlive: () => true }))?.tmux).toBe('%6');
  });
});

describe('sendTerminalMessage refusals', () => {
  it('refuses a non-interactive or dashboard-held holder', async () => {
    await expect(sendTerminalMessage('s1', { ...HOLDER, kind: 'worker' }, 'hi', baseOpts())).rejects.toThrow('interactive');
    await expect(sendTerminalMessage('s2', { ...HOLDER, entrypoint: 'sdk-cli' }, 'hi', baseOpts())).rejects.toThrow('dashboard');
  });

  it('refuses a busy holder and one without a pane', async () => {
    await expect(sendTerminalMessage('s3', { ...HOLDER, status: 'busy' }, 'hi', baseOpts())).rejects.toThrow('busy in terminal');
    const { tmux: _pane, ...paneless } = HOLDER;
    await expect(sendTerminalMessage('s4', paneless, 'hi', baseOpts())).rejects.toThrow('no tmux pane');
  });

  it('refuses when the process is gone or may not be signalled', async () => {
    await expect(
      sendTerminalMessage('s5', HOLDER, 'hi', baseOpts({ probe: () => { throw new TerminalInjectError('the terminal session has exited'); } })),
    ).rejects.toThrow('exited');
    await expect(
      sendTerminalMessage('s6', HOLDER, 'hi', baseOpts({ probe: () => { throw new TerminalInjectError('not permitted to signal the terminal process'); } })),
    ).rejects.toThrow('not permitted');
  });

  it('refuses a holder that is no descendant of the pane pid', async () => {
    const { exec, calls } = makeExec({ paneInfo: `${9999} 0` });
    await expect(
      sendTerminalMessage('s7', HOLDER, 'hi', baseOpts({ exec, readStat: treeReadStat() })),
    ).rejects.toThrow('does not run in that tmux pane');
    expect(calls.some(c => c.args[0] === 'load-buffer')).toBe(false);
  });

  it('refuses a pane in copy mode', async () => {
    const { exec } = makeExec({ paneInfo: `${3000} 1` });
    await expect(sendTerminalMessage('s8', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow('copy mode');
  });

  it('refuses a stopped (suspended) claude', async () => {
    const lines = { ...TREE, 4242: statLine(4242, { ppid: 3500, state: 'T' }) };
    await expect(sendTerminalMessage('s9', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('stopped');
  });

  it('refuses when claude does not own the terminal foreground', async () => {
    const lines = { ...TREE, 4242: statLine(4242, { ppid: 3500, pgrp: 4242, tpgid: 5000 }) };
    await expect(sendTerminalMessage('s10', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('foreground');
  });

  it('refuses bash-mode and slash-command text, and oversized or empty text', async () => {
    await expect(sendTerminalMessage('s11', HOLDER, '!ls', baseOpts())).rejects.toThrow('shell or slash commands');
    await expect(sendTerminalMessage('s12', HOLDER, '/compact', baseOpts())).rejects.toThrow('shell or slash commands');
    await expect(sendTerminalMessage('s13', HOLDER, 'x'.repeat(MAX_TERMINAL_TEXT + 1), baseOpts())).rejects.toThrow('at most');
    await expect(sendTerminalMessage('s14', HOLDER, '   \n\t  ', baseOpts())).rejects.toThrow('empty');
  });
});

describe('sendTerminalMessage inject', () => {
  it('loads the buffer with stdin text, bracketed-pastes, deletes the buffer, then sends Enter', async () => {
    const { exec, calls } = makeExec();
    await sendTerminalMessage('t1', HOLDER, 'Fix the overlay', baseOpts({ exec }));
    const names = calls.map(c => c.args[0]);
    expect(names).toEqual(['display-message', 'load-buffer', 'paste-buffer', 'delete-buffer', 'send-keys']);
    expect(calls[0].args).toContain('-t');
    expect(calls[0].args).toContain('%3');
    expect(calls[1].args[1]).toBe('-b');
    const bufferName = calls[1].args[2];
    expect(bufferName).toMatch(/^sk-[0-9a-f]+$/);
    expect(calls[1].args[3]).toBe('-'); // the text rides in on stdin
    expect(calls[1].input).toBe('Fix the overlay');
    expect(calls[2].args).toEqual(['paste-buffer', '-p', '-b', bufferName, '-t', '%3']);
    expect(calls[3].args).toEqual(['delete-buffer', '-b', bufferName]);
    expect(calls[4].args).toEqual(['send-keys', '-t', '%3', 'Enter']);
  });

  it('appends a space when the text ends in an @token', async () => {
    const { exec, calls } = makeExec();
    await sendTerminalMessage('t2', HOLDER, 'look at @src/main.ts', baseOpts({ exec }));
    expect(calls[1].input).toBe('look at @src/main.ts ');
  });

  it('deletes the buffer even when the paste failed and never sends Enter', async () => {
    const { exec, calls } = makeExec({ pasteFails: true });
    await expect(sendTerminalMessage('t3', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow('tmux send failed');
    const names = calls.map(c => c.args[0]);
    expect(names).toEqual(['display-message', 'load-buffer', 'paste-buffer', 'delete-buffer']);
    expect(calls[2].args).toEqual(['paste-buffer', '-p', '-b', calls[1].args[2], '-t', '%3']);
    expect(names).not.toContain('send-keys');
  });

  it('never sends Enter when claude lost the foreground between paste and Enter', async () => {
    // The descendant walk needs the real tree; the holder's own stat reads come in
    // sequence: foreground check 1 (owns it), then the re-check after the paste (lost).
    const holderReads = [
      statLine(4242, { ppid: 3500 }),
      statLine(4242, { ppid: 3500 }),
      statLine(4242, { ppid: 3500, pgrp: 4242, tpgid: 5000 }),
    ];
    let holderCall = 0;
    const readStat = async (pid: number): Promise<string> => {
      if (pid !== HOLDER.pid) {
        const line = TREE[pid];
        if (line === undefined) throw new TerminalInjectError('the terminal process is gone');
        return line;
      }
      const line = holderReads[Math.min(holderCall++, holderReads.length - 1)];
      if (line === undefined) throw new TerminalInjectError('the terminal process is gone');
      return line;
    };
    const { exec, calls } = makeExec();
    await expect(
      sendTerminalMessage('t4', HOLDER, 'hi', baseOpts({ exec, readStat })),
    ).rejects.toThrow('pasted but not sent');
    const names = calls.map(c => c.args[0]);
    expect(names).toContain('paste-buffer');
    expect(names).not.toContain('send-keys');
  });
});

describe('sendTerminalMessage lock and cooldown', () => {
  it('refuses a second concurrent send for the same session, then continues', async () => {
    const { exec, release } = makeExec({ hangAt: 'display-message' });
    const first = sendTerminalMessage('l1', HOLDER, 'one', baseOpts({ exec }));
    await new Promise(r => setTimeout(r, 5));
    await expect(sendTerminalMessage('l1', HOLDER, 'two', baseOpts())).rejects.toThrow('already being sent');
    release(`${3000} 0`); // the first send completes
    await expect(first).resolves.toBeUndefined();
    // A different session is not blocked by the first one's lock.
    const { exec: exec2 } = makeExec();
    await expect(sendTerminalMessage('l2', HOLDER, 'two', baseOpts({ exec: exec2 }))).resolves.toBeUndefined();
  });

  it('waits for the registry to show busy then idle again, or the cooldown to pass', async () => {
    let status: string = 'idle';
    const readHolder = async () => ({ ...HOLDER, status });
    const { exec: exec1 } = makeExec();
    await sendTerminalMessage('c1', HOLDER, 'first', baseOpts({ exec: exec1, readHolder, cooldownMs: COOLDOWN_MS }));

    // Right after the send the registry shows busy: refused, and the gate remembers it.
    status = 'busy';
    await expect(
      sendTerminalMessage('c1', HOLDER, 'second', baseOpts({ readHolder, cooldownMs: COOLDOWN_MS })),
    ).rejects.toThrow('taking the last message');

    // Idle again with a busy seen in between: the next message goes through.
    status = 'idle';
    const { exec: exec2 } = makeExec();
    await expect(
      sendTerminalMessage('c1', HOLDER, 'third', baseOpts({ exec: exec2, readHolder, cooldownMs: COOLDOWN_MS })),
    ).resolves.toBeUndefined();

    // Without a busy ever seen, the gate holds until the cooldown is over.
    const { exec: exec3 } = makeExec();
    await sendTerminalMessage('c2', HOLDER, 'first', baseOpts({ exec: exec3, readHolder, cooldownMs: COOLDOWN_MS }));
    await expect(
      sendTerminalMessage('c2', HOLDER, 'second', baseOpts({ readHolder, cooldownMs: COOLDOWN_MS })),
    ).rejects.toThrow('wait a moment');

    // Cooldown disabled (0): the gate never applies.
    const { exec: exec4 } = makeExec();
    await expect(
      sendTerminalMessage('c3', HOLDER, 'first', baseOpts({ exec: exec4, readHolder, cooldownMs: 0 })),
    ).resolves.toBeUndefined();
    await expect(
      sendTerminalMessage('c3', HOLDER, 'second', baseOpts({ readHolder, cooldownMs: 0 })),
    ).resolves.toBeUndefined();
  });
});
