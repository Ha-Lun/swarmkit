// Sending a user message into a terminal Claude Code session through its tmux pane.
// The message is pasted (bracketed paste, so the TUI treats it as one string) and
// submitted with a single Enter — but only while claude owns the terminal foreground,
// so the worst race outcome is a pasted line sitting in the prompt, never a command
// the shell would run. The alternative (the registry's messagingSocketPath peer
// protocol) is safer but the receiving session would see the message as coming from
// another session, not from the user.
//
// Known limit, accepted: text the user already typed but left unsent in the TUI prompt
// is submitted together with the dashboard message.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

/** Fresh registry read for the cooldown gate (injected so tests stay hermetic). */
export type HolderReader = (sessionId: string) => Promise<LiveHolder | undefined>;

export interface TerminalInjectOptions {
  exec?: TmuxExec;
  probe?: (pid: number) => void;
  readStat?: (pid: number) => Promise<string>;
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
 * Parses /proc/<pid>/stat after the last ')': state, ppid, pgrp and tpgid. The comm
 * before it may contain spaces and parentheses, so the split starts at field 3.
 */
export function parseProcStat(raw: string): { state: string; ppid: number; pgrp: number; tpgid: number } {
  const cut = raw.lastIndexOf(')');
  if (cut < 0) throw new TerminalInjectError('malformed /proc/<pid>/stat');
  const fields = raw.slice(cut + 1).trim().split(/\s+/);
  // state, ppid, pgrp, session, tty_nr, tpgid, ...
  return { state: fields[0] ?? '', ppid: Number(fields[1]), pgrp: Number(fields[2]), tpgid: Number(fields[5]) };
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

/**
 * The double-send gate: right after a send the TUI is about to turn busy, and a
 * second message queued behind it could race the first. A new send waits until the
 * registry showed busy and then idle again — or the cooldown passed.
 */
async function gate(sessionId: string, opts: Required<Pick<TerminalInjectOptions, 'readHolder' | 'cooldownMs'>>): Promise<void> {
  const state = gates.get(sessionId);
  if (!state || Date.now() - state.sentAt >= opts.cooldownMs) return;
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

/** Refuses a stopped (Ctrl-Z / $EDITOR) claude or one that lost the terminal foreground. */
async function checkForeground(pid: number, readStat: (pid: number) => Promise<string>): Promise<void> {
  let stat;
  try {
    stat = parseProcStat(await readStat(pid));
  } catch (err) {
    if (err instanceof TerminalInjectError) throw err;
    throw new TerminalInjectError('the terminal process is gone');
  }
  if (stat.state === 'T') throw new TerminalInjectError('the terminal session is stopped (suspended)');
  if (stat.pgrp !== stat.tpgid) {
    throw new TerminalInjectError('the terminal session does not own the terminal foreground');
  }
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
  const readHolder = opts.readHolder ?? liveHolder;
  const cooldownMs = opts.cooldownMs ?? COOLDOWN_MS;

  const refusal = holderRefusal(holder);
  if (refusal) throw new TerminalInjectError(refusal);
  probe(holder.pid);

  const cleaned = sanitizeTerminalText(text);
  if (cleaned.length === 0) throw new TerminalInjectError('message is empty');
  if (cleaned.length > MAX_TERMINAL_TEXT) {
    throw new TerminalInjectError(`message must be at most ${MAX_TERMINAL_TEXT} characters`);
  }
  if (/^[!/]/.test(cleaned)) {
    throw new TerminalInjectError('messages starting with ! or / run in the terminal as shell or slash commands; send them from the terminal itself');
  }

  if (locks.has(sessionId)) throw new TerminalInjectError('a message is already being sent');
  locks.add(sessionId);
  try {
    try {
      await gate(sessionId, { readHolder, cooldownMs });

      const pane = holder.tmux!;
      const paneInfo = (await exec(['display-message', '-p', '-t', pane, '#{pane_pid} #{pane_in_mode}'])).trim();
      const [panePidRaw, inMode] = paneInfo.split(/\s+/);
      const panePid = Number(panePidRaw);
      if (!Number.isInteger(panePid) || panePid <= 0) {
        throw new TerminalInjectError('the tmux pane of this session is gone');
      }
      if (!(await isDescendant(holder.pid, panePid, readStat))) {
        throw new TerminalInjectError('this session does not run in that tmux pane');
      }
      if (inMode === '1') throw new TerminalInjectError('the pane is in copy mode; leave it and try again');

      await checkForeground(holder.pid, readStat);

      // 1) load the text into a named buffer, 2) bracketed-paste it into the pane,
      // 3) drop the buffer even when the paste failed, 4) Enter after a short wait —
      // but only when claude still owns the foreground at that moment. An @token at
      // the end gets a trailing space so Enter cannot pick an autocomplete entry.
      const buffer = `sk-${randomBytes(8).toString('hex')}`;
      let pasted = false;
      await exec(['load-buffer', '-b', buffer, '-'], /@\S+$/.test(cleaned) ? `${cleaned} ` : cleaned);
      try {
        await exec(['paste-buffer', '-p', '-b', buffer, '-t', pane]);
        pasted = true;
      } finally {
        await exec(['delete-buffer', '-b', buffer]).catch(() => {});
      }

      await delay(opts.enterDelayMs ?? 200);
      try {
        await checkForeground(holder.pid, readStat);
      } catch (err) {
        if (pasted) {
          throw new TerminalInjectError(
            `claude lost the terminal foreground; the message was pasted but not sent (${(err as Error).message})`,
          );
        }
        throw err;
      }
      await exec(['send-keys', '-t', pane, 'Enter']);
      markSent(sessionId);
    } catch (err) {
      if (err instanceof TerminalInjectError) throw err;
      throw new TerminalInjectError(`tmux send failed: ${(err as Error).message}`);
    }
  } finally {
    locks.delete(sessionId);
  }
}

/** Records a successful send for the cooldown gate. */
function markSent(sessionId: string): void {
  gates.set(sessionId, { sentAt: Date.now(), busySeen: false });
}
