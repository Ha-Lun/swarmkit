// Sending a user message into a terminal Claude Code session through its tmux pane.
// The message is pasted (bracketed paste, so the TUI treats it as one string) and
// submitted with a single Enter — but only while claude owns the terminal foreground
// and its main input box is empty, so the worst race outcome is a pasted line sitting
// in the prompt, never a command the shell would run. The alternative (the registry's
// messagingSocketPath peer protocol) is safer but the receiving session would see the
// message as coming from another session, not from the user.
//
// Known limit, accepted: text the user already typed but left unsent in the TUI prompt
// is refused (the prompt-must-be-empty check), so it cannot be submitted together with
// the dashboard message.
import { spawn } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DASHBOARD_ENTRYPOINTS, liveHolder } from './livesessions.ts';
import type { LiveHolder } from './livesessions.ts';

/** Refusal with a user-facing reason (mapped to 409 by the HTTP layer). */
export class TerminalInjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalInjectError';
  }
}

/** tmux invocation with an args array (never a shell); `input` goes to stdin (load-buffer -). */
export type TmuxExec = (args: string[], input?: string) => Promise<string>;

const TMUX_TIMEOUT_MS = 3_000;

/** Default exec: spawn tmux directly, capture stdout, reject on non-zero exit. */
const defaultExec: TmuxExec = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tmux ${args[0]} timed out`));
    }, TMUX_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `tmux ${args[0]} failed (exit ${code})`));
    });
    // An EPIPE (tmux missing or exiting early) must not crash the server: the
    // error/close handlers above already reject the promise.
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

/** Signal-0 probe: throws for a gone process and for one we may not signal (EPERM = refusal). */
function defaultProbe(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new TerminalInjectError(
      e.code === 'ESRCH' ? 'the terminal session has exited' : 'not permitted to signal the terminal process',
    );
  }
}

/** /proc/<pid>/stat of a pid; any read failure is a refusal (the process may be gone). */
async function defaultReadStat(pid: number): Promise<string> {
  try {
    return await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    throw new TerminalInjectError('the terminal process is gone');
  }
}

/** rdev of a device path (/dev/pts/N); a missing node is a refusal. */
async function defaultStat(path: string): Promise<number> {
  try {
    return statSync(path).rdev;
  } catch {
    throw new TerminalInjectError('the tmux pane terminal is gone');
  }
}

/** All pids that descend from `pid` (transitive children via /proc/<p>/stat ppid). */
async function defaultListDescendants(pid: number): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir('/proc');
  } catch {
    // Without /proc the child check cannot run: refuse instead of passing blind.
    throw new TerminalInjectError("cannot inspect the terminal session's children");
  }
  const ppidOf = new Map<number, number>();
  for (const name of names) {
    const p = Number(name);
    if (!Number.isInteger(p) || p <= 0) continue;
    try {
      ppidOf.set(p, parseProcStat(await readFile(`/proc/${p}/stat`, 'utf8')).ppid);
    } catch {
      // vanished between readdir and read: not a child anyway
    }
  }
  const out: number[] = [];
  const frontier = [pid];
  while (frontier.length > 0) {
    const cur = frontier.pop()!;
    for (const [p, ppid] of ppidOf) {
      if (ppid === cur) {
        out.push(p);
        frontier.push(p);
      }
    }
  }
  return out;
}

/** Where a process's open file descriptors point (readlink results), or [] when gone. */
async function defaultFds(pid: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(`/proc/${pid}/fd`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; // the process just left
    // EACCES and friends (e.g. a setuid child): cannot verify — refuse.
    throw new TerminalInjectError("cannot inspect the terminal session's children");
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      out.push(await readlink(`/proc/${pid}/fd/${name}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; // fd closed meanwhile
      throw new TerminalInjectError("cannot inspect the terminal session's children");
    }
  }
  return out;
}

/** Fresh registry read for the cooldown gate (injected so tests stay hermetic). */
export type HolderReader = (sessionId: string) => Promise<LiveHolder | undefined>;

export interface TerminalInjectOptions {
  exec?: TmuxExec;
  probe?: (pid: number) => void;
  readStat?: (pid: number) => Promise<string>;
  /** rdev of a device path (the pane tty); injected in tests. */
  stat?: (path: string) => Promise<number>;
  /** Transitive children of a pid (fd ownership check); injected in tests. */
  listDescendants?: (pid: number) => Promise<number[]>;
  /** Readlink targets of a pid's open fds; an inspection error is a refusal. */
  fds?: (pid: number) => Promise<string[]>;
  /** Registry read for the cooldown gate; defaults to the live-holder file. */
  readHolder?: HolderReader;
  /** Wait between the paste and the Enter key (ms). */
  enterDelayMs?: number;
  /** Cooldown after a send (ms); tests shrink it. */
  cooldownMs?: number;
}

/** Max characters of one terminal message (a TUI prompt is not a document). */
export const MAX_TERMINAL_TEXT = 16_000;
/** After a send, the next one waits for the registry to show busy then idle again — or this long. */
export const COOLDOWN_MS = 5_000;

/** SGR escape sequences (colors and attributes) captured with `-e`. */
const SGR_RE = /\x1b\[[0-9;]*m/g;
/**
 * Dim spans: suggestion placeholders, from \x1b[2m to the next SGR that resets dim
 * (`0`, `22` or an empty first param, alone or combined like `0;1`). An unterminated
 * span is left in place, so its text counts as typed text (fails closed).
 */
const DIM_SPAN_RE = /\x1b\[2m[\s\S]*?\x1b\[(?:0|22)?(?:;[0-9;]*)?m/g;
/** claude's main input marker: ❯ (U+276F) followed by a no-break or normal space. */
const PROMPT_MARKERS = ['❯\u00a0', '❯ '] as const;

/**
 * Text sanitizer for a tmux paste: strips C0 control characters except \n and \t
 * (ESC is one of them), DEL and C1, and trims the leading whitespace. Everything
 * else (every visible character, any script, emoji) passes through.
 */
export function sanitizeTerminalText(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue;
    if (code >= 0x7f && code < 0xa0) continue; // DEL + C1
    out += ch;
  }
  return out.replace(/^\s+/, '');
}

/**
 * Parses /proc/<pid>/stat after the last ')': comm, state, ppid, pgrp, tty_nr and
 * tpgid. The comm may contain spaces and parentheses, so the split starts after the
 * last ')' — the comm itself is the text between the first '(' and that one.
 */
export function parseProcStat(raw: string): { comm: string; state: string; ppid: number; pgrp: number; tty: number; tpgid: number } {
  const open = raw.indexOf('(');
  const cut = raw.lastIndexOf(')');
  if (open < 0 || cut < 0 || cut < open) throw new TerminalInjectError('malformed /proc/<pid>/stat');
  const comm = raw.slice(open + 1, cut);
  const fields = raw.slice(cut + 1).trim().split(/\s+/);
  // state, ppid, pgrp, session, tty_nr, tpgid, ...
  return {
    comm,
    state: fields[0] ?? '',
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    tty: Number(fields[4]),
    tpgid: Number(fields[5]),
  };
}

/** True when `pid` is `ancestor` itself or one of its /proc descendants (bounded walk). */
async function isDescendant(
  pid: number,
  ancestor: number,
  readStat: (pid: number) => Promise<string>,
): Promise<boolean> {
  let cur = pid;
  for (let depth = 0; depth < 32; depth++) {
    if (cur === ancestor) return true;
    if (!Number.isInteger(cur) || cur <= 1) return false;
    try {
      cur = parseProcStat(await readStat(cur)).ppid;
    } catch {
      return false;
    }
  }
  return false;
}

/** The refusal for a holder that must not receive injected text, or undefined when it may. */
function holderRefusal(holder: LiveHolder): string | undefined {
  if (holder.kind !== 'interactive') return 'only interactive terminal sessions accept messages';
  if (DASHBOARD_ENTRYPOINTS.has(holder.entrypoint ?? '')) return 'this session already belongs to the dashboard';
  if (holder.status !== 'idle') return 'busy in terminal';
  if (!holder.tmux) return 'no tmux pane found for this session';
  return undefined;
}

/** One in-flight send per session id. */
const locks = new Set<string>();

/** Cooldown state of the last send per session id. */
const gates = new Map<string, { sentAt: number; busySeen: boolean }>();

/** Drops gate entries whose cooldown is over (swept on every mark). */
function sweepGates(now: number): void {
  for (const [id, state] of gates) {
    if (now - state.sentAt >= COOLDOWN_MS) gates.delete(id);
  }
}

/**
 * The double-send gate: right after a send the TUI is about to turn busy, and a
 * second message queued behind it could race the first. A new send waits until the
 * registry showed busy and then idle again — or the cooldown passed.
 */
async function gate(sessionId: string, opts: Required<Pick<TerminalInjectOptions, 'readHolder' | 'cooldownMs'>>): Promise<void> {
  const state = gates.get(sessionId);
  if (!state || Date.now() - state.sentAt >= opts.cooldownMs) {
    if (state) gates.delete(sessionId);
    return;
  }
  const fresh = await opts.readHolder(sessionId).catch(() => undefined);
  const status = fresh?.status ?? 'idle';
  if (status === 'busy') {
    state.busySeen = true;
    throw new TerminalInjectError('the terminal session is still taking the last message');
  }
  if (status === 'idle' && state.busySeen) {
    gates.delete(sessionId);
    return;
  }
  throw new TerminalInjectError('wait a moment before sending another message into the terminal');
}

/**
 * The busy refusal comes before gate(), so a busy holder would never mark busySeen:
 * when a cooldown is running and the holder turns busy, remember it before refusing.
 */
function noteHolderStatus(sessionId: string, holder: LiveHolder, cooldownMs: number): void {
  const state = gates.get(sessionId);
  if (!state) return;
  if (Date.now() - state.sentAt >= cooldownMs) {
    gates.delete(sessionId);
    return;
  }
  if (holder.status === 'busy') state.busySeen = true;
}

// ---------------------------------------------------------------------------
// capture-pane parsing: claude's input box is the last pair of rule lines
// ---------------------------------------------------------------------------

/** Visible text of one capture line: dim spans removed, then all SGR stripped. */
export function visible(line: string): string {
  return line.replace(DIM_SPAN_RE, '').replace(SGR_RE, '');
}

/** True for the rule lines that bracket claude's input box (20+ box-drawing dashes). */
function isRule(line: string): boolean {
  return /^─{20,}$/.test(visible(line).trim());
}

/** The content lines between the LAST pair of rule lines, or undefined without a box. */
export function findInputBox(capture: string): string[] | undefined {
  const lines = capture.split('\n');
  const rules: number[] = [];
  lines.forEach((line, i) => {
    if (isRule(line)) rules.push(i);
  });
  for (let k = rules.length - 1; k >= 1; k--) {
    const open = rules[k - 1]!;
    const close = rules[k]!;
    if (close - open >= 2) return lines.slice(open + 1, close);
  }
  return undefined;
}

/** The prompt marker of a visible box line, or undefined when the line is not the prompt. */
function promptMarker(visibleLine: string): string | undefined {
  return PROMPT_MARKERS.find(m => visibleLine.startsWith(m));
}

/**
 * Pre-paste check: the box must hold claude's EMPTY main prompt — the first line
 * starts with ❯ and nothing follows it, and no further line inside the box has
 * text (a multi-line draft, a paste chip, a picker row: all refused).
 */
export function requireEmptyPrompt(capture: string): void {
  const box = findInputBox(capture);
  if (!box) throw new TerminalInjectError("cannot see claude's prompt");
  const first = visible(box[0]!);
  const marker = promptMarker(first);
  if (marker === undefined || !marker.startsWith('❯')) {
    throw new TerminalInjectError("claude's prompt is not at its main input");
  }
  if (first.slice(marker.length).trim().length > 0) {
    throw new TerminalInjectError('the terminal prompt already has text in it');
  }
  for (const line of box.slice(1)) {
    if (visible(line).trim().length > 0) {
      throw new TerminalInjectError('the terminal prompt already has text in it');
    }
  }
}

/**
 * Pre-Enter check: the box must still hold our pasted text — the first line starts
 * with ❯ and has visible content (the text or a `[Pasted text` chip). A missing box
 * or a `!` marker (the user switched to bash mode) refuses: no Enter is sent.
 */
export function requirePastedPrompt(capture: string, sent: string): void {
  const box = findInputBox(capture);
  if (!box) throw new TerminalInjectError("claude's input box is gone");
  const first = visible(box[0]!);
  const marker = promptMarker(first);
  if (marker === undefined || !marker.startsWith('❯')) {
    throw new TerminalInjectError("claude's prompt is not at its main input");
  }
  // The box must start with OUR text (or claude's chip for a long paste): any text is
  // not enough, since a `/` or `#` the user typed in the gap would turn Enter into a command.
  const rest = first.slice(marker.length).trimStart();
  const expected = (sent.split('\n')[0] ?? '').split('\t')[0]!.trim().slice(0, 16);
  const ours = /^\[Pasted text #\d+/.test(rest) || (expected.length > 0 && rest.startsWith(expected));
  if (!ours) throw new TerminalInjectError('the pasted text did not land in the prompt');
}

/** Refuses a stopped (Ctrl-Z / $EDITOR) claude, a foreign pid, or a lost foreground. */
async function checkForeground(
  pid: number,
  readStat: (pid: number) => Promise<string>,
): Promise<void> {
  let st;
  try {
    st = parseProcStat(await readStat(pid));
  } catch (err) {
    if (err instanceof TerminalInjectError) throw err;
    throw new TerminalInjectError('the terminal process is gone');
  }
  // The pid must still be the claude process (or its node runner), not a recycled pid.
  if (!(st.comm === 'claude' || st.comm === 'node' || st.comm.startsWith('claude'))) {
    throw new TerminalInjectError('pid no longer belongs to claude');
  }
  if ('TtZX'.includes(st.state)) throw new TerminalInjectError('the terminal session is stopped (suspended)');
  if (st.pgrp !== st.tpgid) {
    throw new TerminalInjectError('the terminal session does not own the terminal foreground');
  }
}

/** The pane must be claude's own terminal: the holder's tty_nr is the pane tty's rdev. */
async function checkTty(
  holderPid: number,
  paneTty: string,
  readStat: (pid: number) => Promise<string>,
  statRdev: (path: string) => Promise<number>,
): Promise<void> {
  const st = parseProcStat(await readStat(holderPid));
  const rdev = await statRdev(paneTty);
  if (st.tty !== rdev) {
    throw new TerminalInjectError('this session does not run on this pane terminal');
  }
}

/** Refuses when any child of claude holds the pane tty (or /dev/tty) open on any fd. */
async function checkChildren(
  holderPid: number,
  paneTty: string,
  listDescendants: (pid: number) => Promise<number[]>,
  fds: (pid: number) => Promise<string[]>,
): Promise<void> {
  const kids = await listDescendants(holderPid);
  for (const kid of kids) {
    for (const fd of await fds(kid)) {
      if (fd === paneTty || fd === '/dev/tty') {
        throw new TerminalInjectError('a child process (e.g. an editor) owns the terminal input');
      }
    }
  }
}

/** The pane state one display-message answers: pid, mode, tty and synchronize flag. */
interface PaneState {
  panePid: number;
  paneTty: string;
}

/** display-message must name a live, unsynchronized, non-copy-mode pane with a tty. */
async function readPane(pane: string, exec: TmuxExec): Promise<PaneState> {
  const out = (await exec([
    'display-message',
    '-p',
    '-t',
    pane,
    '#{pane_pid} #{pane_in_mode} #{pane_tty} #{pane_synchronized}',
  ])).trim();
  const [panePidRaw, inMode, paneTty, sync] = out.split(/\s+/);
  const panePid = Number(panePidRaw);
  if (!Number.isInteger(panePid) || panePid <= 0) {
    throw new TerminalInjectError('the tmux pane of this session is gone');
  }
  if (inMode !== '0') throw new TerminalInjectError('the pane is in copy mode; leave it and try again');
  if (sync !== '0') throw new TerminalInjectError('the pane is synchronized; turn synchronize-panes off first');
  if (!paneTty || !paneTty.startsWith('/dev/')) {
    throw new TerminalInjectError('the tmux pane has no terminal');
  }
  return { panePid, paneTty };
}

/** Sends `text` into the tmux pane that holds the terminal session, or throws TerminalInjectError. */
export async function sendTerminalMessage(
  sessionId: string,
  holder: LiveHolder,
  text: string,
  opts: TerminalInjectOptions = {},
): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  const probe = opts.probe ?? defaultProbe;
  const readStat = opts.readStat ?? defaultReadStat;
  const statRdev = opts.stat ?? defaultStat;
  const listDescendants = opts.listDescendants ?? defaultListDescendants;
  const fds = opts.fds ?? defaultFds;
  const readHolder = opts.readHolder ?? liveHolder;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;

  const refusal = holderRefusal(holder);
  if (refusal) {
    noteHolderStatus(sessionId, holder, cooldownMs);
    throw new TerminalInjectError(refusal);
  }
  probe(holder.pid);

  const cleaned = sanitizeTerminalText(text);
  if (cleaned.length === 0) throw new TerminalInjectError('message is empty');
  if (cleaned.length > MAX_TERMINAL_TEXT) {
    throw new TerminalInjectError(`message must be at most ${MAX_TERMINAL_TEXT} characters`);
  }
  // Every line: a leading !, /, # or & would run as a shell, slash, comment or
  // background command once the prompt takes the text.
  if (cleaned.split('\n').some(line => /^\s*[!/#&]/.test(line))) {
    throw new TerminalInjectError('lines starting with !, /, # or & run in the terminal as shell, slash, comment or background commands; send them from the terminal itself');
  }

  if (locks.has(sessionId)) throw new TerminalInjectError('a message is already being sent');
  locks.add(sessionId);
  try {
    try {
      await gate(sessionId, { readHolder, cooldownMs });

      const pane = holder.tmux!;
      // One full liveness check: pane identity (pid ancestry, mode, synchronize, tty),
      // process identity and state (claude, not stopped, foreground) and child fd ownership.
      const check = async (): Promise<PaneState> => {
        const state = await readPane(pane, exec);
        if (!(await isDescendant(holder.pid, state.panePid, readStat))) {
          throw new TerminalInjectError('this session does not run in that tmux pane');
        }
        await checkForeground(holder.pid, readStat);
        await checkTty(holder.pid, state.paneTty, readStat, statRdev);
        await checkChildren(holder.pid, state.paneTty, listDescendants, fds);
        return state;
      };
      const capture = async (): Promise<string> => {
        try {
          return await exec(['capture-pane', '-p', '-e', '-t', pane]);
        } catch {
          throw new TerminalInjectError("cannot see claude's prompt");
        }
      };

      await check();
      // The prompt must be claude's empty main input box — last check before the paste.
      requireEmptyPrompt(await capture());

      // 1) load the text into a named buffer (deleted in the finally even when the
      // load itself timed out with a stored buffer), 2) re-check, 3) bracketed-paste
      // into the pane, 4) Enter after a short wait — but only after one more
      // re-check and a capture that still shows our text in claude's ❯ box. An
      // @token at the end gets a trailing space so Enter cannot pick an autocomplete.
      const buffer = `sk-${randomBytes(8).toString('hex')}`;
      let pasted = false;
      try {
        // T4: the load is inside the finally-protected block — a timed-out
        // load-buffer may still have stored the buffer.
        await exec(['load-buffer', '-b', buffer, '-'], /@\S+$/.test(cleaned) ? `${cleaned} ` : cleaned);
        await check();
        // Capture again right before the paste: the user may have typed since the first one.
        requireEmptyPrompt(await capture());
        await exec(['paste-buffer', '-p', '-b', buffer, '-t', pane]);
        pasted = true;
        // The cooldown starts as soon as the pane has the text, Enter or not.
        markSent(sessionId);
      } finally {
        await exec(['delete-buffer', '-b', buffer]).catch(() => {});
      }

      await delay(opts.enterDelayMs ?? 200);
      try {
        await check();
        requirePastedPrompt(await capture(), cleaned);
      } catch (err) {
        throw new TerminalInjectError(
          `claude lost the terminal foreground; the message was pasted but not sent (${(err as Error).message})`,
        );
      }
      await exec(['send-keys', '-t', pane, 'Enter']);
    } catch (err) {
      if (err instanceof TerminalInjectError) throw err;
      throw new TerminalInjectError(`tmux send failed: ${(err as Error).message}`);
    }
  } finally {
    locks.delete(sessionId);
  }
}

/** Records a send for the cooldown gate (paste succeeded, Enter or not). */
function markSent(sessionId: string): void {
  sweepGates(Date.now());
  gates.set(sessionId, { sentAt: Date.now(), busySeen: false });
}
