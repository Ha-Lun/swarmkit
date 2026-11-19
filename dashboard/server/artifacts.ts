// Artifact store: files an agent hands the user, ${XDG_CACHE_HOME || ~/.cache}/swarmkit/artifacts/<sessionId>/.
// Page sessions get the dir as $SWARMKIT_ARTIFACTS_DIR. Private (dir 0700, no symlinks followed).
import { constants as fsConstants, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_SESSION_RE } from './images.ts';
import type { PublishedArtifact, WrittenArtifact } from '../src/shared/types.ts';

/** Store root; read from the environment on each call so tests can redirect it. */
export function artifactsRoot(): string {
  const cache = process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)
    ? process.env.XDG_CACHE_HOME
    : path.join(os.homedir(), '.cache');
  return path.join(cache, 'swarmkit', 'artifacts');
}

/** Directory of one session's artifacts (not created). Throws on an id that is not path-safe. */
export function artifactDir(sessionId: string): string {
  if (!IMAGE_SESSION_RE.test(sessionId)) throw new Error('invalid session id');
  return path.join(artifactsRoot(), sessionId);
}

/** Creates (0700) a private directory and refuses a symlink, a non-directory or someone else's directory. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('artifact store path is not a plain directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('artifact store is owned by another user');
}

/** The session's artifact dir, created if missing. */
export function ensureArtifactDir(sessionId: string): string {
  const dir = artifactDir(sessionId);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  return dir;
}

/** Removes a session's artifacts (best effort; a symlinked dir is unlinked, never followed). */
export function deleteArtifacts(sessionId: string): void {
  if (!IMAGE_SESSION_RE.test(sessionId)) return;
  try {
    rmSync(artifactDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort.
  }
}

/** Max bytes served for one artifact download. */
export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
/** Overridable in tests (the fs-size stub alternative). */
let downloadCap = MAX_DOWNLOAD_BYTES;
/** Test-only: replace the download cap (restored by the caller). */
export function _setMaxDownloadBytesForTest(n: number): void {
  downloadCap = n;
}

/** Plain basename check for a published artifact file name. */
export function validArtifactName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (Buffer.byteLength(name, 'utf8') > 200) return false;
  if (name === '.' || name === '..') return false;
  if (name.startsWith('.')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  // Control characters (NUL, CR, LF, ...) would also break the Content-Disposition header.
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

/**
 * The session's store dir for reading, or undefined unless it is a plain directory owned by
 * us whose path has no symlinked part (an agent could swap it for a link to ~/.ssh).
 */
export async function plainStoreDir(sessionId: string): Promise<string | undefined> {
  let dir: string;
  try {
    dir = artifactDir(sessionId);
    const st = await lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return undefined;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return undefined;
    if ((await realpath(dir)) !== dir) return undefined;
  } catch {
    return undefined;
  }
  return dir;
}

/** Published files of one session, newest first (at most 100). Missing dir -> []. */
export async function listArtifacts(sessionId: string): Promise<PublishedArtifact[]> {
  const dir = await plainStoreDir(sessionId);
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PublishedArtifact[] = [];
  for (const name of names) {
    if (!validArtifactName(name)) continue;
    let st;
    try {
      st = lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    out.push({
      name,
      size: st.size,
      mtime: st.mtimeMs,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(name)}`,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 100);
}

/**
 * Opens a file for download: O_NOFOLLOW and O_NONBLOCK (a planted FIFO must not block a
 * thread), regular file, single link, within the cap, and (where /proc exists) the opened
 * file really is absPath, so a parent directory swapped for a symlink after the checks loses.
 */
export async function openForDownload(absPath: string): Promise<{ handle: Awaited<ReturnType<typeof open>>; size: number; mtimeMs: number } | undefined> {
  let handle;
  try {
    handle = await open(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const st = await handle.stat();
    let opened = absPath;
    try {
      opened = await realpath(`/proc/self/fd/${handle.fd}`);
    } catch {
      // No /proc (not Linux): the O_NOFOLLOW and realpath checks stand alone.
    }
    if (!st.isFile() || st.nlink !== 1 || st.size > downloadCap || opened !== absPath) {
      await handle.close();
      return undefined;
    }
    return { handle, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    try {
      await handle.close();
    } catch {
      // Best effort.
    }
    return undefined;
  }
}

/**
 * Removes artifact directories that no live session owns and whose newest entry is older
 * than maxAgeMs. Only plain directories named like a session id are touched; never followed.
 */
export function pruneOrphanArtifacts(isKnown: (sessionId: string) => boolean, maxAgeMs: number, now = Date.now()): number {
  let removed = 0;
  try {
    const root = artifactsRoot();
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!IMAGE_SESSION_RE.test(entry.name) || isKnown(entry.name)) continue;
      const dir = path.join(root, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          // A fork adoption leaves a link at the placeholder id (and an agent could
          // plant one): unlink the link itself — never follow it — when the id is
          // no longer a known session (or its target is gone).
          rmSync(dir);
          removed += 1;
          continue;
        }
        if (!entry.isDirectory()) continue;
        let newest = lstatSync(dir).mtimeMs;
        for (const name of readdirSync(dir)) newest = Math.max(newest, lstatSync(path.join(dir, name)).mtimeMs);
        if (now - newest < maxAgeMs) continue;
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {
        // Best effort: skip what cannot be read or removed.
      }
    }
  } catch {
    // No store yet.
  }
  return removed;
}

/** Content-Type by file extension (text types carry a charset). */
export function artifactContentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'zip': return 'application/zip';
    case 'gz': return 'application/gzip';
    case 'tar': return 'application/x-tar';
    case 'csv': return 'text/csv; charset=utf-8';
    case 'json': return 'application/json; charset=utf-8';
    case 'txt': return 'text/plain; charset=utf-8';
    case 'md': return 'text/markdown; charset=utf-8';
    case 'html': return 'text/html; charset=utf-8';
    case 'xml': return 'application/xml; charset=utf-8';
    case 'mp4': return 'video/mp4';
    case 'mp3': return 'audio/mpeg';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    default: return 'application/octet-stream';
  }
}

/** attachment filename with an ASCII fallback and an RFC 5987 encoded value. */
export function artifactDisposition(name: string): string {
  const fallback = name.replace(/["\\\x00-\x1f\x7f\u0080-\u{10FFFF}]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Response headers for a download (GET and HEAD share them). */
export function downloadHeaders(filename: string, size: number): Record<string, string | number> {
  return {
    'Content-Type': artifactContentType(filename),
    'Content-Length': size,
    'Content-Disposition': artifactDisposition(filename),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, no-store',
  };
}

/**
 * Files the session wrote (Write/Edit/MultiEdit/NotebookEdit) that still exist inside
 * its cwd: each recorded path resolved against cwd, then kept only when its realpath is
 * strictly inside the real cwd and is a regular file. Newest first, at most 200.
 */
export async function writtenArtifacts(sessionId: string, cwd: string, paths: Iterable<string>): Promise<WrittenArtifact[]> {
  let realCwd: string;
  try {
    realCwd = await realpath(cwd);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: WrittenArtifact[] = [];
  for (const p of paths) {
    let real: string;
    try {
      real = await realpath(path.resolve(cwd, p));
    } catch {
      continue; // Missing or unreadable.
    }
    if (real === realCwd || !real.startsWith(realCwd + path.sep) || hiddenPart(realCwd, real)) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    let st;
    try {
      st = await lstat(real);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    out.push({
      path: real,
      rel: path.relative(realCwd, real),
      size: st.size,
      mtime: st.mtimeMs,
      url: `/api/sessions/${encodeURIComponent(sessionId)}/written?path=${encodeURIComponent(real)}`,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 200);
}

/**
 * True when a path below cwd has a dot-named part (.env, .ssh/, .config/, .git/): a write
 * there is recorded even when it was denied, so such files are never offered.
 */
function hiddenPart(realCwd: string, real: string): boolean {
  return path.relative(realCwd, real).split(path.sep).some(part => part.startsWith('.'));
}

/** GET check: requested must be absolute and the realpath of a recorded entry inside cwd. */
export async function resolveWritten(
  cwd: string,
  paths: Iterable<string>,
  requested: string,
): Promise<{ handle: Awaited<ReturnType<typeof open>>; size: number; mtimeMs: number; real: string } | undefined> {
  if (!path.isAbsolute(requested)) return undefined;
  let realCwd: string;
  let realRequested: string;
  try {
    realCwd = await realpath(cwd);
    realRequested = await realpath(requested);
  } catch {
    return undefined;
  }
  if (realRequested === realCwd || !realRequested.startsWith(realCwd + path.sep) || hiddenPart(realCwd, realRequested)) return undefined;
  for (const p of paths) {
    let real: string;
    try {
      real = await realpath(path.resolve(cwd, p));
    } catch {
      continue;
    }
    if (real === realRequested) {
      const opened = await openForDownload(real);
      return opened ? { ...opened, real } : undefined;
    }
  }
  return undefined;
}
