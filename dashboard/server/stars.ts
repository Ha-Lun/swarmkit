// Starred folders: user-pinned quick-access dirs under $HOME, stored as a JSON
// array of absolute paths in $XDG_CONFIG_HOME/claude-fleet/starred.json.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DirError } from './dirs.ts';
import { resolveDirInHome } from './paths.ts';

/** At most this many folders can be starred. */
const MAX_STARS = 50;

/** Serialises concurrent setStar writers so two toggles cannot clobber each other. */
let writeChain: Promise<void> = Promise.resolve();

/** Storage file: $XDG_CONFIG_HOME/claude-fleet/starred.json, default ~/.config/claude-fleet/starred.json. */
export function starsFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
  return path.join(base, 'claude-fleet', 'starred.json');
}

async function readStored(): Promise<string[]> {
  try {
    const raw = await readFile(starsFilePath(), 'utf8');
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
