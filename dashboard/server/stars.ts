// Starred folders: user-pinned quick-access dirs under $HOME, stored as a JSON
// array of absolute paths in $XDG_CONFIG_HOME/swarmkit/starred.json.
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DirError } from './dirs.ts';
import { resolveDirInHome } from './paths.ts';

/** At most this many folders can be starred. */
const MAX_STARS = 50;

/** Serialises concurrent setStar writers so two toggles cannot clobber each other. */
let writeChain: Promise<void> = Promise.resolve();

function configBase(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
}

/** Storage file: $XDG_CONFIG_HOME/swarmkit/starred.json, default ~/.config/swarmkit/starred.json. */
export function starsFilePath(): string {
  return path.join(configBase(), 'swarmkit', 'starred.json');
}

/**
 * One-time move of the pre-rename $XDG_CONFIG_HOME/claude-fleet/starred.json to `file`.
 * Returns the old content (or undefined when there is none). The old file is deleted only
 * after the new one was written, so a failed write never loses the stars.
 */
async function migrateOldStars(file: string): Promise<string | undefined> {
  const oldFile = path.join(configBase(), 'claude-fleet', 'starred.json');
  let raw: string;
  try {
    raw = await readFile(oldFile, 'utf8');
  } catch {
    return undefined;
  }
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, raw, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await unlink(oldFile);
    await rmdir(path.dirname(oldFile)).catch(() => undefined); // only succeeds when empty
  } catch {
    // Keep the old file; its content is still used for this read.
  }
  return raw;
}

async function readStored(): Promise<string[]> {
  try {
    const file = starsFilePath();
    const raw = await readFile(file, 'utf8').catch(() => migrateOldStars(file));
    if (raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/** True when a stored entry still resolves to itself inside $HOME. */
async function isValidStored(p: string): Promise<boolean> {
  try {
    const resolved = await resolveDirInHome(p);
    return 'dir' in resolved && resolved.dir === p;
  } catch {
    return false;
  }
}

/** Read stored entries, keep those that still validate, then cap. */
async function validStored(): Promise<string[]> {
  const out: string[] = [];
  for (const p of await readStored()) {
    if (await isValidStored(p)) out.push(p);
  }
  return out.slice(0, MAX_STARS);
}

/** Stored stars that still validate (stale, out-of-home, or symlink-swapped ones are hidden). */
export async function listStars(): Promise<string[]> {
  return validStored();
}

async function writeStored(next: string[]): Promise<void> {
  const file = starsFilePath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await rename(tmp, file);
}

async function applySetStar(rawPath: unknown, starred: boolean): Promise<string[]> {
  const resolved = await resolveDirInHome(rawPath);
  if (!starred) {
    const dir = 'dir' in resolved ? resolved.dir : undefined;
    const stored = await readStored();
    const next = stored.filter(p => p !== rawPath && p !== dir);
    await writeStored(next);
    return listStars();
  }
  if ('error' in resolved) throw new DirError(400, resolved.error);
  const dir = resolved.dir;
  const valid = await validStored();
  const next = valid.filter(p => p !== dir);
  if (!valid.includes(dir) && next.length >= MAX_STARS) {
    throw new DirError(400, 'too many starred folders');
  }
  next.push(dir);
  await writeStored(next);
  return next;
}

/** Star or unstar a folder (validated to an existing dir inside $HOME); resolves with the fresh list. */
export function setStar(rawPath: unknown, starred: boolean): Promise<string[]> {
  const run = writeChain.then(() => applySetStar(rawPath, starred));
  // A failure must not jam the chain for later callers.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
