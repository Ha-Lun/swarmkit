// Sending a user message into a terminal Claude Code session through its tmux pane.
// The message is pasted (bracketed paste, so the TUI treats it as one string) and
// submitted with a single Enter — but only while claude owns the terminal foreground
// and its prompt is empty, so the worst race outcome is a pasted line sitting in the
// prompt, never a command the shell would run. The alternative (the registry's
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
    return [];
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

/** Where a process's stdin (fd 0) points, or undefined when it cannot be read. */
async function defaultFd0(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/fd/0`);
  } catch {
    return undefined;
  }
}

/** Fresh registry read for the cooldown gate (injected so tests stay hermetic). */
export type HolderReader = (sessionId: string) => Promise<LiveHolder | undefined>;

export interface TerminalInjectOptions {
  exec?: TmuxExec;
  probe?: (pid: number) => void;
  readStat?: (pid: number) => Promise<string>;
  /** rdev of a device path (the pane tty); injected in tests. */
  stat?: (path: string) => Promise<number>;
  /** Transitive children of a pid (fd-0 ownership check); injected in tests. */
  listDescendants?: (pid: number) => Promise<number[]>;
  /** Where a pid's stdin points, or undefined. */
  fd0?: (pid: number) => Promise<string | undefined>;
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
/** claude's main input prompt marker: ❯ (U+276F) followed by a no-break space. */
const PROMPT_MARK = '❯\u00a0';

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
 * Parses /proc/<pid>/stat after the last ')': state, ppid, pgrp, tty_nr and tpgid.
 * The comm before it may contain spaces and parentheses, so the split starts at field 3.
 */
export function parseProcStat(raw: string): { state: string; ppid: number; pgrp: number; tty: number; tpgid: number } {
  const cut = raw.lastIndexOf(')');
  if (cut < 0) throw new TerminalInjectError('malformed /proc/<pid>/stat');
  const fields = raw.slice(cut + 1).trim().split(/\s+/);
  // state, ppid, pgrp, session, tty_nr, tpgid, ...
  return {
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

/**
 * One prompt line's leftover text after the ❯ marker: dim spans (suggestion
 * placeholders) are removed first, then the remaining SGR — undefined when the
 * line is not claude's prompt at all.
 */
export function promptRest(line: string): string | undefined {
  if (!line.replace(SGR_RE, '').includes(PROMPT_MARK)) return undefined;
  const rawIdx = line.indexOf(PROMPT_MARK);
  if (rawIdx < 0) return ''; // marker split by an SGR sequence: treat as empty
  // From \x1b[2m to the next \x1b[0m or \x1b[22m: dim suggestion text, not user input.
  let after = line.slice(rawIdx + PROMPT_MARK.length);
  after = after.replace(/\x1b\[2m[\s\S]*?(?:\x1b\[0m|\x1b\[22m)/g, '');
  return after.replace(SGR_RE, '').trim();
}

/** Refuses a stopped (Ctrl-Z / $EDITOR) claude or one that lost the terminal foreground. */
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

/** Refuses when a child of claude (an editor, a picker) owns the terminal input. */
async function checkChildren(
  holderPid: number,
  paneTty: string,
  listDescendants: (pid: number) => Promise<number[]>,
  fd0: (pid: number) => Promise<string | undefined>,
): Promise<void> {
  const kids = await listDescendants(holderPid);
  for (const kid of kids) {
    if ((await fd0(kid)) === paneTty) {
      throw new TerminalInjectError('a child process (e.g. an editor) owns the terminal input');
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

/** claude's main prompt, seen through capture-pane, must be empty. */
async function checkPromptEmpty(pane: string, exec: TmuxExec): Promise<void> {
  let out: string;
  try {
    out = await exec(['capture-pane', '-p', '-e', '-t', pane]);
  } catch {
    throw new TerminalInjectError("cannot see claude's prompt");
  }
  let rest: string | undefined;
  for (const line of out.split('\n')) {
    const r = promptRest(line);
    if (r !== undefined) rest = r; // the last prompt line wins
  }
  if (rest === undefined) throw new TerminalInjectError("cannot see claude's prompt");
  if (rest.length > 0) throw new TerminalInjectError('the terminal prompt already has text in it');
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
  const fd0 = opts.fd0 ?? defaultFd0;
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
  if (/^[!/#&]/.test(cleaned)) {
    throw new TerminalInjectError('messages starting with !, /, # or & run in the terminal as shell, slash, comment or background commands; send them from the terminal itself');
  }

  if (locks.has(sessionId)) throw new TerminalInjectError('a message is already being sent');
  locks.add(sessionId);
  try {
    try {
      await gate(sessionId, { readHolder, cooldownMs });

      const pane = holder.tmux!;
      // One full liveness check: pane identity (pid ancestry, mode, synchronize, tty),
      // process state (stopped, foreground) and child fd-0 ownership.
      const check = async (): Promise<PaneState> => {
        const state = await readPane(pane, exec);
        if (!(await isDescendant(holder.pid, state.panePid, readStat))) {
          throw new TerminalInjectError('this session does not run in that tmux pane');
        }
        await checkForeground(holder.pid, readStat);
        await checkTty(holder.pid, state.paneTty, readStat, statRdev);
        await checkChildren(holder.pid, state.paneTty, listDescendants, fd0);
        return state;
      };

      await check();
      // The prompt must be claude's empty main prompt — checked once, before the paste.
      await checkPromptEmpty(pane, exec);

      // 1) load the text into a named buffer, 2) re-check, 3) bracketed-paste it into
      // the pane, 4) drop the buffer even when the paste failed, 5) Enter after a
      // short wait — but only after one more re-check. An @token at the end gets a
      // trailing space so Enter cannot pick an autocomplete entry.
      const buffer = `sk-${randomBytes(8).toString('hex')}`;
      let pasted = false;
      await exec(['load-buffer', '-b', buffer, '-'], /@\S+$/.test(cleaned) ? `${cleaned} ` : cleaned);
      try {
        await check();
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
