import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveHolder, liveHolders } from '../server/livesessions.ts';
import {
  COOLDOWN_MS,
  MAX_TERMINAL_TEXT,
  parseProcStat,
  promptRest,
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

const PANE_TTY = '/dev/pts/7';
/** rdev of /dev/pts/7 as seen on this machine class: tty_nr in /proc/<pid>/stat matches it. */
const TTY_NR = 34823;

/** /proc/<pid>/stat-shaped line: `pid (comm) state ppid pgrp session tty_nr tpgid …`. */
function statLine(pid: number, o: { comm?: string; state?: string; ppid?: number; pgrp?: number; tpgid?: number; tty?: number } = {}): string {
  const pgrp = o.pgrp ?? pid;
  return `${pid} (${o.comm ?? 'claude'}) ${o.state ?? 'S'} ${o.ppid ?? 1} ${pgrp} 42 ${o.tty ?? TTY_NR} ${o.tpgid ?? pgrp} 0 1 2 3`;
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

/** Fake tmux: records calls, answers display/capture, optionally fails or hangs a call. */
function makeExec(opts: { paneInfo?: string; prompt?: string; pasteFails?: boolean; hangAt?: string; failAt?: string } = {}) {
  const calls: Call[] = [];
  let release: (value: string) => void = () => {};
  let hung = false;
  const exec: TmuxExec = (args, input) => {
    calls.push({ args, input });
    if (opts.hangAt === args[0] && !hung) {
      hung = true;
      return new Promise<string>(resolve => {
        release = resolve;
      });
    }
    if (opts.failAt === args[0]) return Promise.reject(new Error(`${args[0]} exploded`));
    if (args[0] === 'display-message') return Promise.resolve(opts.paneInfo ?? `${3000} 0 ${PANE_TTY} 0`);
    if (args[0] === 'capture-pane') return Promise.resolve(opts.prompt ?? '❯\u00a0');
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
  stat: async () => TTY_NR,
  listDescendants: async () => [3500],
  fd0: async () => '/dev/null',
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
    const line = statLine(1234, { comm: 'cla) ude (x', state: 'S', ppid: 55, pgrp: 1234, tpgid: 1234, tty: 34823 });
    expect(parseProcStat(line)).toEqual({ state: 'S', ppid: 55, pgrp: 1234, tty: 34823, tpgid: 1234 });
  });

  it('reads a stopped state and a foreign foreground group', () => {
    expect(parseProcStat(statLine(9, { state: 'T' })).state).toBe('T');
    const fg = parseProcStat(statLine(9, { pgrp: 9, tpgid: 777 }));
    expect(fg.pgrp).not.toBe(fg.tpgid);
  });
});

describe('promptRest', () => {
  it('finds the text after ❯ and strips SGR', () => {
    expect(promptRest('❯\u00a0')).toBe('');
    expect(promptRest('\x1b[39m❯\u00a0\x1b[0m')).toBe('');
    expect(promptRest('❯\u00a0draft text')).toBe('draft text');
    expect(promptRest('❯\u00a01. Yes')).toBe('1. Yes'); // picker row: non-dim text
  });

  it('removes dim spans (suggestion placeholders) before judging', () => {
    // A dim suggestion is NOT user text: the prompt counts as empty.
    expect(promptRest('\x1b[39m❯\u00a0\x1b[2mYes, do all three\x1b[0m')).toBe('');
    expect(promptRest('❯\u00a0\x1b[2msuggestion\x1b[22m more')).toBe('more');
  });

  it('answers undefined for lines that are not the prompt', () => {
    expect(promptRest('some transcript output')).toBeUndefined();
    expect(promptRest('')).toBeUndefined();
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
    const { exec, calls } = makeExec({ paneInfo: `${9999} 0 ${PANE_TTY} 0` });
    await expect(
      sendTerminalMessage('s7', HOLDER, 'hi', baseOpts({ exec, readStat: treeReadStat() })),
    ).rejects.toThrow('does not run in that tmux pane');
    expect(calls.some(c => c.args[0] === 'load-buffer')).toBe(false);
  });

  it('refuses a pane in copy mode and a synchronized pane', async () => {
    const { exec } = makeExec({ paneInfo: `${3000} 1 ${PANE_TTY} 0` });
    await expect(sendTerminalMessage('s8', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow('copy mode');
    const { exec: exec2 } = makeExec({ paneInfo: `${3000} 0 ${PANE_TTY} 1` });
    await expect(sendTerminalMessage('s9', HOLDER, 'hi', baseOpts({ exec: exec2 }))).rejects.toThrow('synchronized');
  });

  it('refuses when the holder tty does not match the pane tty (nested screen/dtach)', async () => {
    // The holder runs on another tty than the pane: claude sits inside screen/vim.
    const lines = { ...TREE, 4242: statLine(4242, { ppid: 3500, tty: TTY_NR + 1 }) };
    await expect(sendTerminalMessage('s10', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('pane terminal');
  });

  it('refuses a stopped (suspended) claude', async () => {
    const lines = { ...TREE, 4242: statLine(4242, { ppid: 3500, state: 'T' }) };
    await expect(sendTerminalMessage('s11', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('stopped');
  });

  it('refuses when claude does not own the terminal foreground', async () => {
    const lines = { ...TREE, 4242: statLine(4242, { ppid: 3500, pgrp: 4242, tpgid: 5000 }) };
    await expect(sendTerminalMessage('s12', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('foreground');
  });

  it('refuses when a child process (e.g. an editor) owns the terminal input', async () => {
    await expect(
      sendTerminalMessage('s13', HOLDER, 'hi', baseOpts({ fd0: async (pid: number) => (pid === 3500 ? PANE_TTY : '/dev/null') })),
    ).rejects.toThrow('owns the terminal input');
  });

  it('refuses when capture-pane shows no claude prompt', async () => {
    const { exec } = makeExec({ prompt: 'some window content without a marker' });
    await expect(sendTerminalMessage('s14', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow("cannot see claude's prompt");
  });

  it('refuses when the prompt already holds text (draft or picker row)', async () => {
    const { exec } = makeExec({ prompt: '\x1b[39m❯\u00a0leftover draft\x1b[0m' });
    await expect(sendTerminalMessage('s15', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow('already has text');
    const { exec: exec2 } = makeExec({ prompt: '❯\u00a01. Yes, apply the plan' });
    await expect(sendTerminalMessage('s16', HOLDER, 'hi', baseOpts({ exec: exec2 }))).rejects.toThrow('already has text');
  });

  it('refuses bash-mode, slash, comment and background text, and oversized or empty text', async () => {
    await expect(sendTerminalMessage('s17', HOLDER, '!ls', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s18', HOLDER, '/compact', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s19', HOLDER, '# note', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s20', HOLDER, '& sleep 5', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s21', HOLDER, 'x'.repeat(MAX_TERMINAL_TEXT + 1), baseOpts())).rejects.toThrow('at most');
    await expect(sendTerminalMessage('s22', HOLDER, '   \n\t  ', baseOpts())).rejects.toThrow('empty');
  });
});

describe('sendTerminalMessage inject', () => {
  it('checks the pane, loads the buffer with stdin text, bracketed-pastes, deletes the buffer, then sends Enter', async () => {
    const { exec, calls } = makeExec();
    await sendTerminalMessage('t1', HOLDER, 'Fix the overlay', baseOpts({ exec }));
    const names = calls.map(c => c.args[0]);
    // check (display) -> prompt (capture) -> load -> re-check (display) -> paste ->
    // delete -> re-check (display) -> Enter.
    expect(names).toEqual([
      'display-message', 'capture-pane', 'load-buffer',
      'display-message', 'paste-buffer', 'delete-buffer',
      'display-message', 'send-keys',
    ]);
    expect(calls[0].args).toContain('-t');
    expect(calls[0].args).toContain('%3');
    expect(calls[0].args[4]).toContain('pane_pid');
    expect(calls[0].args[4]).toContain('pane_tty');
    expect(calls[0].args[4]).toContain('pane_synchronized');
    expect(calls[1].args.slice(0, 3)).toEqual(['capture-pane', '-p', '-e']);
    expect(calls[2].args[1]).toBe('-b');
    const bufferName = calls[2].args[2];
    expect(bufferName).toMatch(/^sk-[0-9a-f]+$/);
    expect(calls[2].args[3]).toBe('-'); // the text rides in on stdin
    expect(calls[2].input).toBe('Fix the overlay');
    expect(calls[4].args).toEqual(['paste-buffer', '-p', '-b', bufferName, '-t', '%3']);
    expect(calls[5].args).toEqual(['delete-buffer', '-b', bufferName]);
    expect(calls[7].args).toEqual(['send-keys', '-t', '%3', 'Enter']);
  });

  it('accepts a prompt with only dim suggestion text and appends a space for an @token', async () => {
    const { exec, calls } = makeExec({ prompt: '\x1b[39m❯\u00a0\x1b[2mYes, do all three\x1b[0m' });
    await sendTerminalMessage('t2', HOLDER, 'look at @src/main.ts', baseOpts({ exec }));
    expect(calls[2].input).toBe('look at @src/main.ts ');
  });

  it('deletes the buffer even when the paste failed and never sends Enter', async () => {
    const { exec, calls } = makeExec({ pasteFails: true });
    await expect(sendTerminalMessage('t3', HOLDER, 'hi', baseOpts({ exec }))).rejects.toThrow('paste failed');
    const names = calls.map(c => c.args[0]);
    expect(names).toEqual([
      'display-message', 'capture-pane', 'load-buffer',
      'display-message', 'paste-buffer', 'delete-buffer',
    ]);
    expect(calls[4].args).toEqual(['paste-buffer', '-p', '-b', calls[2].args[2], '-t', '%3']);
    expect(names).not.toContain('send-keys');
  });

  it('never sends Enter when claude lost the foreground between paste and Enter', async () => {
    // Holder stat reads: checks 1 and 2 need three each (walk, foreground, tty);
    // the eighth read (the re-check before Enter) sees a foreign foreground group.
    const ok = statLine(4242, { ppid: 3500 });
    const lost = statLine(4242, { ppid: 3500, pgrp: 4242, tpgid: 5000 });
    const holderReads = [ok, ok, ok, ok, ok, ok, ok, lost];
    let i = 0;
    const readStat = async (pid: number): Promise<string> => {
      const line = pid === HOLDER.pid ? holderReads[Math.min(i++, holderReads.length - 1)] : TREE[pid];
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

  it('re-checks before the paste: a pane that dies after load-buffer is refused', async () => {
    // Check 1 passes (three holder stat reads); the pre-paste re-check finds the
    // holder process gone (the walk fails) — refused before any paste.
    const holderReads = [
      statLine(4242, { ppid: 3500 }), statLine(4242, { ppid: 3500 }), statLine(4242, { ppid: 3500 }),
    ];
    let i = 0;
    const readStat = async (pid: number): Promise<string> => {
      if (pid !== HOLDER.pid) return TREE[pid] ?? (() => { throw new TerminalInjectError('gone'); })();
      const line = holderReads[i++];
      if (line === undefined) throw new TerminalInjectError('the terminal process is gone');
      return line;
    };
    const { exec, calls } = makeExec();
    await expect(
      sendTerminalMessage('t5', HOLDER, 'hi', baseOpts({ exec, readStat })),
    ).rejects.toThrow('does not run in that tmux pane');
    const names = calls.map(c => c.args[0]);
    expect(names).toContain('load-buffer');
    expect(names).toContain('delete-buffer'); // the buffer never leaks
    expect(names).not.toContain('paste-buffer');
    expect(names).not.toContain('send-keys');
  });
});

describe('sendTerminalMessage lock and cooldown', () => {
  it('refuses a second concurrent send for the same session, then continues', async () => {
    const { exec, release } = makeExec({ hangAt: 'display-message' });
    const first = sendTerminalMessage('l1', HOLDER, 'one', baseOpts({ exec }));
    await new Promise(r => setTimeout(r, 5));
    await expect(sendTerminalMessage('l1', HOLDER, 'two', baseOpts())).rejects.toThrow('already being sent');
    release(`${3000} 0 ${PANE_TTY} 0`); // the first send completes
    await expect(first).resolves.toBeUndefined();
    // A different session is not blocked by the first one's lock.
    const { exec: exec2 } = makeExec();
    await expect(sendTerminalMessage('l2', HOLDER, 'two', baseOpts({ exec: exec2 }))).resolves.toBeUndefined();
  });

  it('marks busySeen from the busy refusal, then allows the send once idle again', async () => {
    let status: string = 'idle';
    const readHolder = async () => ({ ...HOLDER, status });
    const { exec: exec1 } = makeExec();
    await sendTerminalMessage('c1', HOLDER, 'first', baseOpts({ exec: exec1, readHolder, cooldownMs: COOLDOWN_MS }));

    // Right after the send the registry shows busy: the holder refusal fires (the
    // passed holder is busy), but the gate must remember the busy phase (otherwise
    // idle would never re-open the gate within the cooldown).
    status = 'busy';
    await expect(
      sendTerminalMessage('c1', { ...HOLDER, status: 'busy' }, 'second', baseOpts({ readHolder, cooldownMs: COOLDOWN_MS })),
    ).rejects.toThrow('busy in terminal');

    // Idle again with a busy seen in between: the next message goes through at once.
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

  it('marks the cooldown when the paste succeeded even if Enter then failed', async () => {
    const { exec } = makeExec({ failAt: 'send-keys' });
    await expect(
      sendTerminalMessage('m1', HOLDER, 'first', baseOpts({ exec, readHolder: async () => undefined, cooldownMs: COOLDOWN_MS })),
    ).rejects.toThrow('tmux send failed');
    // The paste landed, so the gate is already active: an immediate send with an idle
    // holder waits out the cooldown instead of racing the pane.
    await expect(
      sendTerminalMessage('m1', HOLDER, 'second', baseOpts({ readHolder: async () => ({ ...HOLDER, status: 'idle' }), cooldownMs: COOLDOWN_MS })),
    ).rejects.toThrow('wait a moment');
  });
});
