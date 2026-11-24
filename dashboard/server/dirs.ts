// Folder picker backend: lists directories under $HOME only (never outside it).
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import type { DirEntry, DirListing } from '../src/shared/types';
import { homeReal, isInside, resolveDirInHome } from './paths.ts';

/** Thrown for requests the folder picker must answer with an HTTP error status. */
export class DirError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** At most this many entries are returned per listing. */
const MAX_ENTRIES = 500;

/**
 * Lists the directories of `path` (default $HOME). The target must exist and lie inside
 * $HOME; only directories and directory symlinks that resolve inside $HOME are kept,
 * dotfiles unless `hidden`, and never node_modules. Entries are sorted case-insensitively.
 */
export async function listDirs(rawPath?: string, hidden = false): Promise<DirListing> {
  const home = await homeReal();
  let target: string;
  try {
    target = await realpath(rawPath && rawPath.length > 0 ? rawPath : home);
  } catch {
    throw new DirError(400, 'path does not exist');
  }
  if (!isInside(home, target)) {
    throw new DirError(400, 'path must be inside your home directory');
  }
  let dirents: Dirent[];
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch {
    throw new DirError(400, 'path is not a readable directory');
  }
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    if (!hidden && d.name.startsWith('.')) continue;
    if (d.name === 'node_modules') continue;
    const entryPath = path.join(target, d.name);
    if (d.isSymbolicLink()) {
      // Only symlinks that resolve to a directory inside $HOME are listed.
      let real: string | undefined;
      try {
        real = await realpath(entryPath);
      } catch {
        continue;
      }
      if (!isInside(home, real)) continue;
      const st = await stat(real).catch(() => undefined);
      if (!st?.isDirectory()) continue;
    }
    const isGitRepo = await stat(path.join(entryPath, '.git'))
      .then((st) => st.isDirectory() || st.isFile())
      .catch(() => false);
    entries.push({ name: d.name, path: entryPath, isGitRepo });
    if (entries.length >= MAX_ENTRIES) break;
  }
  entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const listing: DirListing = { path: target, entries };
  if (target !== home) listing.parent = path.dirname(target);
  return listing;
}

/**
 * Creates a single folder `name` directly inside `parent` (both must stay inside
 * $HOME). Returns the created absolute path.
 */
export async function createDir(parent: unknown, name: unknown): Promise<{ path: string }> {
  const resolved = await resolveDirInHome(parent);
  if ('error' in resolved) throw new DirError(400, resolved.error);
  if (typeof name !== 'string') throw new DirError(400, 'folder name must be a string');
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new DirError(400, 'folder name is required');
  if (Buffer.byteLength(trimmed, 'utf8') > 255) throw new DirError(400, 'folder name is too long');
  if (trimmed === '.' || trimmed === '..') throw new DirError(400, 'folder name is reserved');
  if (trimmed.startsWith('.')) throw new DirError(400, 'folder name must not start with a dot');
  if (trimmed.includes('/') || trimmed.includes('\\')) throw new DirError(400, 'folder name must not contain slashes');
  // NUL and other control characters are never valid in a folder name.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) throw new DirError(400, 'folder name contains invalid characters');
  const created = path.join(resolved.dir, trimmed);
  try {
    await mkdir(created);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') throw new DirError(409, 'a folder with that name already exists');
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new DirError(403, 'permission denied: cannot create a folder here');
    }
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG' || code === 'EINVAL') {
      throw new DirError(400, 'cannot create a folder here');
    }
    throw err;
  }
  return { path: created };
}
