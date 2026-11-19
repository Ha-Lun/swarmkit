import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liveHolder, liveHolders } from '../server/livesessions.ts';
import {
  COOLDOWN_MS,
  MAX_TERMINAL_TEXT,
  findInputBox,
  parseProcStat,
  requireEmptyPrompt,
  requirePastedPrompt,
  sanitizeTerminalText,
  sendTerminalMessage,
  TerminalInjectError,
  visible,
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

// --- capture fixtures from a real claude in tmux ---

const RULE = '─'.repeat(24);
const rule = (s: string): string => `\x1b[38;5;244m${s}`;
/** The idle input box: rule, `❯⍽` + dim suggestion, rule. */
const IDLE_BOX = [
  rule(RULE),
  '\x1b[39m❯\u00a0\x1b[2mTry "write a test for <filepath>"\x1b[0m',
  rule(RULE),
].join('\n');
/** Bash mode: the marker is `!` and the rules are recoloured — no `❯` in the box. */
const BASH_BOX = [
  '\x1b[38;5;214m' + RULE,
  '!\u00a0\x1b[2m\x1b[39mTry "write a test"\x1b[0m',
  '\x1b[38;5;214m' + RULE,
].join('\n');
/** A picker (/model): no rule-bracketed box at all, cursor row with a normal space. */
const PICKER = [
  'Select a model',
  '\x1b[38;5;153m❯\x1b[39m 2. Sonnet',
  '  3. Haiku',
].join('\n');
/** A multi-line draft with an empty first line inside the box. */
const MULTILINE_DRAFT = [
  rule(RULE),
  '\x1b[39m❯\u00a0',
  '  hello',
  rule(RULE),
].join('\n');
/** A bracketed paste of "a\\nb". */
const PASTE_CHUNK = [
  rule(RULE),
  '\x1b[39m❯\u00a0a',
  '  b',
  rule(RULE),
].join('\n');
/** A big paste chip: NOT dim. */
const PASTE_CHIP = [
  rule(RULE),
  '\x1b[39m❯\u00a0[Pasted text #1 +12 lines]\x1b[0m',
  rule(RULE),
].join('\n');
/** Transcript history echoes user messages above the box (normal space, background). */
const ECHO_AND_BOX = [
  '\x1b[33m❯ /model\x1b[0m',
  IDLE_BOX,
].join('\n');

/** Fake tmux: records calls, answers display/capture (prompts queue, last repeats).
 *  Without a prompts queue, the first capture shows the idle box and later captures
 *  echo the text that load-buffer carried (the paste landed). */
function makeExec(opts: { paneInfo?: string; prompts?: string[]; pasteFails?: boolean; hangAt?: string; failAt?: string } = {}) {
  const calls: Call[] = [];
  let release: (value: string) => void = () => {};
  let hung = false;
  let captureCount = 0;
  let lastInput: string | undefined;
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
    if (args[0] === 'load-buffer') lastInput = input;
    if (args[0] === 'capture-pane') {
      if (opts.prompts) return Promise.resolve(opts.prompts[Math.min(captureCount++, opts.prompts.length - 1)]);
      return Promise.resolve(
        captureCount++ === 0
          ? IDLE_BOX
          : [rule(RULE), `\x1b[39m❯\u00a0${lastInput ?? ''}`, rule(RULE)].join('\n'),
      );
    }
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
  fds: async () => ['/dev/null'],
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

describe('capture parsing (visible / findInputBox / prompt checks)', () => {
  it('visible strips dim spans and remaining SGR', () => {
    expect(visible('\x1b[39m❯\u00a0\x1b[2mTry "x"\x1b[0m')).toBe('❯\u00a0');
    expect(visible('\x1b[38;5;153m❯\x1b[39m 2. Sonnet')).toBe('❯ 2. Sonnet');
    expect(visible('\x1b[39m❯\u00a0\x1b[2mYes, do all three')).toBe('❯\u00a0'); // dim to end of line
  });

  it('finds the last rule-bracketed box and ignores echoes and footer lines', () => {
    expect(findInputBox(IDLE_BOX)).toHaveLength(1);
    expect(visible(findInputBox(IDLE_BOX)![0]!)).toBe('❯\u00a0');
    // The echo line above the box is not part of it.
    expect(findInputBox(ECHO_AND_BOX)).toHaveLength(1);
    // Pickers have no box at all.
    expect(findInputBox(PICKER)).toBeUndefined();
    expect(findInputBox('')).toBeUndefined();
    // Adjacent rules (empty box) are not a box: an earlier pair wins if any.
    expect(findInputBox(`${rule(RULE)}\n${rule(RULE)}\n${IDLE_BOX}`)).toHaveLength(1);
  });

  it('requireEmptyPrompt allows the idle box and a split marker with empty rest', () => {
    expect(() => requireEmptyPrompt(IDLE_BOX)).not.toThrow();
    expect(() => requireEmptyPrompt(ECHO_AND_BOX)).not.toThrow();
    // SGR splitting the marker no longer fails open: stripped text is inspected.
    expect(() => requireEmptyPrompt(`${rule(RULE)}\n\x1b[36m❯\x1b[39m\u00a0\n${rule(RULE)}`)).not.toThrow();
  });

  it('requireEmptyPrompt refuses pickers, bash mode, drafts, pastes and chips', () => {
    expect(() => requireEmptyPrompt(PICKER)).toThrow("cannot see claude's prompt");
    expect(() => requireEmptyPrompt('')).toThrow("cannot see claude's prompt");
    expect(() => requireEmptyPrompt(BASH_BOX)).toThrow("not at its main input");
    expect(() => requireEmptyPrompt(MULTILINE_DRAFT)).toThrow('already has text');
    expect(() => requireEmptyPrompt(PASTE_CHUNK)).toThrow('already has text');
    expect(() => requireEmptyPrompt(PASTE_CHIP)).toThrow('already has text');
    // A split marker with text is refused too.
    expect(() => requireEmptyPrompt(`${rule(RULE)}\n\x1b[36m❯\x1b[39m draft\n${rule(RULE)}`)).toThrow('already has text');
  });

  it('requirePastedPrompt accepts our text and refuses a bash-mode or gone box', () => {
    const pasted = [
      rule(RULE),
      '\x1b[39m❯\u00a0hello there',
      rule(RULE),
    ].join('\n');
    expect(() => requirePastedPrompt(pasted)).not.toThrow();
    expect(() => requirePastedPrompt(PASTE_CHIP)).not.toThrow(); // the chip is our paste
    expect(() => requirePastedPrompt(BASH_BOX)).toThrow('not at its main input');
    expect(() => requirePastedPrompt(PICKER)).toThrow('input box is gone');
    expect(() => requirePastedPrompt(IDLE_BOX)).toThrow('did not land');
  });
});

describe('parseProcStat', () => {
  it('parses comm (spaces and parentheses) and the fields after the last )', () => {
    const line = statLine(1234, { comm: 'cla) ude (x', state: 'S', ppid: 55, pgrp: 1234, tpgid: 1234, tty: 34823 });
    expect(parseProcStat(line)).toEqual({ comm: 'cla) ude (x', state: 'S', ppid: 55, pgrp: 1234, tty: 34823, tpgid: 1234 });
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

  it('refuses when the pid no longer belongs to claude (comm check)', async () => {
    const lines = { ...TREE, 4242: statLine(4242, { comm: 'vim', ppid: 3500 }) };
    await expect(sendTerminalMessage('s13', HOLDER, 'hi', baseOpts({ readStat: treeReadStat(lines) }))).rejects.toThrow('no longer belongs to claude');
  });

  it('refuses when a child process (e.g. an editor) owns the pane tty or /dev/tty', async () => {
    await expect(
      sendTerminalMessage('s14', HOLDER, 'hi', baseOpts({ fds: async (pid: number) => (pid === 3500 ? [PANE_TTY] : []) })),
    ).rejects.toThrow('owns the terminal input');
    await expect(
      sendTerminalMessage('s15', HOLDER, 'hi', baseOpts({ fds: async () => ['/dev/tty'] })),
    ).rejects.toThrow('owns the terminal input');
  });

  it('refuses when the child fds or /proc cannot be inspected', async () => {
    await expect(
      sendTerminalMessage('s16', HOLDER, 'hi', baseOpts({ fds: async () => { throw new TerminalInjectError("cannot inspect the terminal session's children"); } })),
    ).rejects.toThrow('cannot inspect');
    await expect(
      sendTerminalMessage('s17', HOLDER, 'hi', baseOpts({ listDescendants: async () => { throw new TerminalInjectError("cannot inspect the terminal session's children"); } })),
    ).rejects.toThrow('cannot inspect');
  });

  it('refuses bash mode, pickers and a garbled capture before anything is pasted', async () => {
    const bash = makeExec({ prompts: [BASH_BOX] });
    await expect(sendTerminalMessage('s18', HOLDER, 'hi', baseOpts({ exec: bash.exec }))).rejects.toThrow('not at its main input');
    const picker = makeExec({ prompts: [PICKER] });
    await expect(sendTerminalMessage('s19', HOLDER, 'hi', baseOpts({ exec: picker.exec }))).rejects.toThrow("cannot see claude's prompt");
    const garbled = makeExec({ prompts: ['\x1b[31m???'] });
    await expect(sendTerminalMessage('s20', HOLDER, 'hi', baseOpts({ exec: garbled.exec }))).rejects.toThrow("cannot see claude's prompt");
  });

  it('refuses a multi-line draft, a paste chunk and a big paste chip in the box', async () => {
    const draft = makeExec({ prompts: [MULTILINE_DRAFT] });
    await expect(sendTerminalMessage('s21', HOLDER, 'hi', baseOpts({ exec: draft.exec }))).rejects.toThrow('already has text');
    const chunk = makeExec({ prompts: [PASTE_CHUNK] });
    await expect(sendTerminalMessage('s22', HOLDER, 'hi', baseOpts({ exec: chunk.exec }))).rejects.toThrow('already has text');
    const chip = makeExec({ prompts: [PASTE_CHIP] });
    await expect(sendTerminalMessage('s23', HOLDER, 'hi', baseOpts({ exec: chip.exec }))).rejects.toThrow('already has text');
  });

  it('refuses leading !, /, # or & on ANY line, and oversized or empty text', async () => {
    await expect(sendTerminalMessage('s24', HOLDER, '!ls', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s25', HOLDER, '/compact', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s26', HOLDER, '# note', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s27', HOLDER, '& sleep 5', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s28', HOLDER, 'fine\n !steal', baseOpts())).rejects.toThrow('shell, slash');
    await expect(sendTerminalMessage('s29', HOLDER, 'x'.repeat(MAX_TERMINAL_TEXT + 1), baseOpts())).rejects.toThrow('at most');
    await expect(sendTerminalMessage('s30', HOLDER, '   \n\t  ', baseOpts())).rejects.toThrow('empty');
  });
});

describe('sendTerminalMessage inject', () => {
  it('checks pane and prompt, loads the buffer with stdin text, pastes, deletes, then sends Enter', async () => {
    const { exec, calls } = makeExec();
    await sendTerminalMessage('t1', HOLDER, 'Fix the overlay', baseOpts({ exec }));
    const names = calls.map(c => c.args[0]);
    // check (display) -> prompt (capture) -> load -> re-check (display) -> paste ->
    // delete -> re-check (display) + capture -> Enter.
    expect(names).toEqual([
      'display-message', 'capture-pane', 'load-buffer',
      'display-message', 'paste-buffer', 'delete-buffer',
      'display-message', 'capture-pane', 'send-keys',
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
    expect(calls[8].args).toEqual(['send-keys', '-t', '%3', 'Enter']);
  });

  it('accepts the idle box and appends a space for an @token', async () => {
    const { exec, calls } = makeExec();
    await sendTerminalMessage('t2', HOLDER, 'look at @src/main.ts', baseOpts({ exec }));
    expect(calls[2].input).toBe('look at @src/main.ts ');
  });

  it('deletes the buffer even when load-buffer or the paste failed', async () => {
    const failedLoad = makeExec({ failAt: 'load-buffer' });
    await expect(sendTerminalMessage('t3', HOLDER, 'hi', baseOpts({ exec: failedLoad.exec }))).rejects.toThrow('load-buffer exploded');
    let names = failedLoad.calls.map(c => c.args[0]);
    expect(names).toContain('delete-buffer'); // a timed-out load may have stored the buffer
    expect(names).not.toContain('send-keys');

    const failedPaste = makeExec({ pasteFails: true });
    await expect(sendTerminalMessage('t4', HOLDER, 'hi', baseOpts({ exec: failedPaste.exec }))).rejects.toThrow('paste failed');
    names = failedPaste.calls.map(c => c.args[0]);
    expect(names).toEqual([
      'display-message', 'capture-pane', 'load-buffer',
      'display-message', 'paste-buffer', 'delete-buffer',
    ]);
    expect(failedPaste.calls[4].args).toEqual(['paste-buffer', '-p', '-b', failedPaste.calls[2].args[2], '-t', '%3']);
  });

  it('never sends Enter when claude lost the foreground between paste and Enter', async () => {
    // Holder stat reads: each check needs three (walk, foreground, tty). The eighth
    // read (checkForeground of the pre-Enter re-check) sees a foreign foreground.
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
      sendTerminalMessage('t5', HOLDER, 'hi', baseOpts({ exec, readStat })),
    ).rejects.toThrow('pasted but not sent');
    const names = calls.map(c => c.args[0]);
    expect(names).toContain('paste-buffer');
    expect(names).not.toContain('send-keys');
  });

  it('never sends Enter when the capture before Enter shows bash mode', async () => {
    // First capture (pre-load): idle. Second capture (pre-Enter): the user
    // switched to bash mode — the pasted text must not be submitted there.
    const { exec, calls } = makeExec({ prompts: [IDLE_BOX, BASH_BOX] });
    await expect(
      sendTerminalMessage('t6', HOLDER, 'hi', baseOpts({ exec })),
    ).rejects.toThrow('pasted but not sent');
    const names = calls.map(c => c.args[0]);
    expect(names).toContain('paste-buffer');
    expect(names.filter(n => n === 'capture-pane')).toHaveLength(2);
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
      sendTerminalMessage('t7', HOLDER, 'hi', baseOpts({ exec, readStat })),
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
