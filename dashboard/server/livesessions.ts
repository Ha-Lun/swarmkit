// Live Claude Code process registry: while a claude process runs it keeps one JSON
// heartbeat file per pid in ~/.claude/sessions/<pid>.json (env CLAUDE_CONFIG_DIR
// overrides ~/.claude), e.g.
//   {"pid":2134086,"sessionId":"fcecbf36-...","cwd":"...","kind":"interactive",
//    "entrypoint":"cli","status":"busy","updatedAt":1792758047062,...}
// Resuming a session that such a process still owns would fork it: a second process
// appending to the same transcript. This file answers "who holds this session id".
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { claudeConfigDir } from './paths.ts';

export { claudeConfigDir };

/** A running Claude Code process that claims the session id. */
export interface LiveHolder {
  pid: number;
  kind?: string;
  status?: string;
  entrypoint?: string;
}

/** Entrypoints of claude processes this dashboard itself spawned (agent SDK runs). */
export const DASHBOARD_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts']);

/** The 409 message used when a live holder blocks a resume. */
export function holderMessage(pid: number): string {
  return `This session is open in another Claude Code process (pid ${pid}). Exit it there first, or continue it there.`;
}

/** Cached bulk reads of the sessions dir, one entry per dir (bounded). */
const BULK_TTL_MS = 2_000;
const MAX_BULK_CACHE = 8;
const bulkCache = new Map<string, { at: number; dirMtime: number; holders: Map<string, LiveHolder> }>();

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

/** First parsed JSON object of a sessions-dir file, or undefined for anything else. */
function recordOf(raw: string): Record<string, unknown> | undefined {
  let entry: unknown;
  try {
    entry = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof entry !== 'object' || entry === null) return undefined;
  return entry as Record<string, unknown>;
}

/** Holder record from one parsed sessions-dir *.json entry. */
const HOLDER_KEYS = ['kind', 'status', 'entrypoint'] as const;

/** LiveHolder extracted from a session record, or undefined when it is not a live holder. */
function holderOf(rec: Record<string, unknown>, isAlive: (pid: number) => boolean): LiveHolder | undefined {
  const pid = rec.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (!isAlive(pid)) return undefined;
  return {
    pid,
    ...Object.fromEntries(
      HOLDER_KEYS.filter((k) => typeof rec[k] === 'string').map((k) => [k, rec[k]]),
    ),
  } as LiveHolder;
}

/** One bulk read of the sessions dir: sessionId -> holder, first record per id wins. */
async function readHolders(dir: string, isAlive: (pid: number) => boolean): Promise<Map<string, LiveHolder>> {
  const holders = new Map<string, LiveHolder>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return holders;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // other files like *.key are ignored
    let raw: string;
    try {
      raw = (await readFile(path.join(dir, name))).toString('utf8');
    } catch {
      continue; // vanished between readdir and read: not a holder anyway
    }
    const rec = recordOf(raw);
    if (!rec) continue;
    if (typeof rec.sessionId !== 'string' || rec.sessionId.length === 0) continue;
    if (holders.has(rec.sessionId)) continue; // matching liveHolder: the first record wins
    const holder = holderOf(rec, isAlive);
    if (holder) holders.set(rec.sessionId, holder);
  }
  return holders;
}

/**
 * Cached bulk read of the live registry: sessionId -> holder (pid alive, status included).
 * The default dir (CLAUDE_CONFIG_DIR override or ~/.claude + sessions) is re-read at most
 * every 2 s (BULK_TTL_MS) — plus immediately when the sessions dir changed (mtime differs:
 * a holder file was created or deleted since the cache was filled). Callers with explicit
 * opts (injected dir / probe) always get a fresh read, uncached.
 */
export async function liveHolders(
  opts?: { dir?: string; isAlive?: (pid: number) => boolean },
): Promise<Map<string, LiveHolder>> {
  const dir = opts?.dir ?? path.join(claudeConfigDir(), 'sessions');
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  if (opts) return readHolders(dir, isAlive);
  let dirMtime = 0;
  try {
    dirMtime = (await stat(dir)).mtimeMs;
  } catch {
    dirMtime = 0; // missing dir: cacheable empty state
  }
  const now = Date.now();
  const cached = bulkCache.get(dir);
  if (cached && now - cached.at < BULK_TTL_MS && cached.dirMtime === dirMtime) return cached.holders;
  const holders = await readHolders(dir, isAlive);
  if (bulkCache.size >= MAX_BULK_CACHE && !bulkCache.has(dir)) {
    const oldest = bulkCache.keys().next().value;
    if (oldest !== undefined) bulkCache.delete(oldest);
  }
  bulkCache.set(dir, { at: now, dirMtime, holders });
  return holders;
}

/**
 * Who currently holds `sessionId` in a live claude process, or undefined.
 * Reads every *.json in the sessions dir (other files like *.key are ignored; parse
 * errors are ignored). Always a fresh read: this is the resume fork-protection.
 * The caller decides what a page session does with its own holders: dashboard-spawned
 * processes (entrypoint 'sdk-cli' / 'sdk-ts') are expected.
 */
export async function liveHolder(
  sessionId: string,
  opts?: { dir?: string; isAlive?: (pid: number) => boolean },
): Promise<LiveHolder | undefined> {
  if (sessionId.length === 0) return undefined;
  const dir = opts?.dir ?? path.join(claudeConfigDir(), 'sessions');
  const isAlive = opts?.isAlive ?? defaultIsAlive;
  return (await readHolders(dir, isAlive)).get(sessionId);
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
  const root = opts?.root ?? path.join(claudeConfigDir(), 'projects');
  const file = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}
