// Starred folders: user-pinned quick-access dirs under $HOME, stored as a JSON
// array of absolute paths in $XDG_CONFIG_HOME/claude-fleet/starred.json.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  let raw: string;
  try {
    raw = await readFile(starsFilePath(), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string');
  } catch {
    return [];
  }
}

/** Stored stars that still exist as directories (missing ones are dropped from the response only). */
export async function listStars(): Promise<string[]> {
  const out: string[] = [];
  for (const p of await readStored()) {
    try {
      if ((await stat(p)).isDirectory()) out.push(p);
    } catch {
      // no longer on disk — dropped from the response, the file is left alone
    }
  }
  return out;
}

async function applySetStar(rawPath: unknown, starred: boolean): Promise<string[]> {
  const resolved = await resolveDirInHome(rawPath);
  if ('error' in resolved) throw new DirError(400, resolved.error);
  const dir = resolved.dir;
  const stored = await readStored();
  const next = stored.filter(p => p !== dir);
  if (starred) {
    if (!stored.includes(dir) && next.length >= MAX_STARS) {
      throw new DirError(400, 'too many starred folders');
    }
    next.push(dir);
  }
  const file = starsFilePath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
  return listStars();
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
