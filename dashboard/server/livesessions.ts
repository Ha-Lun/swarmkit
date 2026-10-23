// Live Claude Code process registry: while a claude process runs it keeps one JSON
// heartbeat file per pid in ~/.claude/sessions/<pid>.json (env CLAUDE_CONFIG_DIR
// overrides ~/.claude), e.g.
//   {"pid":2134086,"sessionId":"fcecbf36-...","cwd":"...","kind":"interactive",
//    "entrypoint":"cli","status":"busy","updatedAt":1792758047062,...}
// Resuming a session that such a process still owns would fork it: a second process
// appending to the same transcript. This file answers "who holds this session id".
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** A running Claude Code process that claims the session id. */
export interface LiveHolder {
  pid: number;
  kind?: string;
  status?: string;
  entrypoint?: string;
}

/** Claude config dir: CLAUDE_CONFIG_DIR overrides ~/.claude (non-empty wins). */
export function claudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (typeof override === 'string' && override.trim().length > 0) return override;
  return path.join(homedir(), '.claude');
}

/** Entrypoints of claude processes this dashboard itself spawned (agent SDK runs). */
export const DASHBOARD_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts']);

/** The 409 message used when a live holder blocks a resume. */
export function holderMessage(pid: number): string {
  return `This session is open in another Claude Code process (pid ${pid}). Exit it there first, or continue it there.`;
}

/**
 * Default liveness probe: signal 0 succeeds -> alive; EPERM counts as alive (a pid
 * owned by another uid exists); ESRCH means the process is gone. A stale heartbeat
 * JSON file may outlive its process, so a holder only counts while this reports alive.
 */
function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when the pid parses and the record's sessionId matches. */
function matches(rec: Record<string, unknown>, sessionId: string): boolean {
  return rec.sessionId === sessionId && typeof rec.pid === 'number' && Number.isInteger(rec.pid) && rec.pid > 0;
}

/**
 * Who currently holds `sessionId` in a live claude process, or undefined.
 * Reads every *.json in the sessions dir (other files like *.key are ignored; parse
 * errors are ignored). The caller decides what a page session does with its own
 * holders: dashboard-spawned processes (entrypoint 'sdk-cli' / 'sdk-ts') are expected.
 */
export async function liveHolder(
  sessionId: string,
  opts?: { dir?: string; isAlive?: (pid: number) => boolean },
): Promise<LiveHolder | undefined> {
  if (sessionId.length === 0) return undefined;
  const dir = opts?.dir ?? path.join(claudeConfigDir(), 'sessions');
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let raw: string;
    try {
      raw = (await readFile(path.join(dir, name))).toString('utf8');
    } catch {
      continue; // vanished between readdir and read: not a holder anyway
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (!matches(rec, sessionId) || !isAlive(rec.pid as number)) continue;
    const pid = rec.pid as number;
    return {
      pid,
      ...(typeof rec.kind === 'string' ? { kind: rec.kind } : {}),
      ...(typeof rec.status === 'string' ? { status: rec.status } : {}),
      ...(typeof rec.entrypoint === 'string' ? { entrypoint: rec.entrypoint } : {}),
    };
  }
  return undefined;
}

/**
 * Fresh transcript mtime straight from the transcript file on disk (the watcher's head
 * cache can be up to one scan interval stale). Transcripts live at
 * <projectsRoot>/<cwd encoded>/<sessionId>.jsonl with the watcher's project-dir
 * encoding (all non-alphanumerics become '-'). Undefined when the path does not stat:
 * the caller keeps its cached value then.
 */
export async function freshTranscriptMtimeMs(
  sessionId: string,
  cwd: string,
  opts?: { root?: string },
): Promise<number | undefined> {
  if (sessionId.length === 0 || cwd.length === 0) return undefined;
  const root = opts?.root ?? path.join(homedir(), '.claude', 'projects');
  const file = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}
