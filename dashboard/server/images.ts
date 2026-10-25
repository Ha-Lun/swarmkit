// Image store for pasted screenshots: ${XDG_CACHE_HOME || ~/.cache}/swarmkit/images/<sessionId>/<n>.<ext>.
// Private (dir 0700, files 0600, O_EXCL, no symlinks followed). Synchronous on purpose: the
// session start/send paths are synchronous and the files are small. Never log image data.
import { constants as fsConstants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_IMAGE_BYTES } from '../src/shared/types.ts';
import type { ImageAttachment, ImageMediaType } from '../src/shared/types.ts';

/** Session ids that may name a store directory (page uuids and transcript ids; no dots, no slashes). */
export const IMAGE_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** File names the store hands out and the GET route accepts. */
export const IMAGE_NAME_RE = /^\d{1,4}\.(png|jpg|gif|webp)$/;

const EXT: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const CONTENT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/** Store root; read from the environment on each call so tests can redirect it. */
export function imagesRoot(): string {
  const cache = process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME)
    ? process.env.XDG_CACHE_HOME
    : path.join(os.homedir(), '.cache');
  return path.join(cache, 'swarmkit', 'images');
}

/** Directory of one session's images (not created). Throws on an id that is not path-safe. */
export function imageDir(sessionId: string): string {
  if (!IMAGE_SESSION_RE.test(sessionId)) throw new Error('invalid session id');
  return path.join(imagesRoot(), sessionId);
}

/**
 * Pure check for the GET route: the absolute path of a stored image, or undefined unless
 * the session id and file name are well-formed and the result stays inside the store.
 */
export function resolveImagePath(sessionId: string, name: string): string | undefined {
  if (!IMAGE_SESSION_RE.test(sessionId) || !IMAGE_NAME_RE.test(name)) return undefined;
  const root = imagesRoot();
  const dir = path.join(root, sessionId);
  const file = path.resolve(dir, name);
  return file.startsWith(dir + path.sep) && dir.startsWith(root + path.sep) ? file : undefined;
}

/** Content-Type for a validated image name. */
export function imageContentType(name: string): string {
  return CONTENT_TYPE[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

/** Creates (0700) a private directory and refuses a symlink, a non-directory or someone else's directory. */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('image store path is not a plain directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('image store is owned by another user');
}

/**
 * Writes the images as <n>.<ext> (n = next free number, 1-based) and returns their
 * dashboard URLs and absolute paths in order.
 */
export function saveImages(sessionId: string, images: ImageAttachment[]): { urls: string[]; paths: string[] } {
  const dir = imageDir(sessionId);
  ensurePrivateDir(path.dirname(dir));
  ensurePrivateDir(dir);
  let next = 1;
  for (const name of readdirSync(dir)) {
    const n = /^(\d{1,4})\./.exec(name);
    if (n) next = Math.max(next, Number(n[1]) + 1);
  }
  const urls: string[] = [];
  const paths: string[] = [];
  for (const image of images) {
    const ext = EXT[image.mediaType];
    const bytes = Buffer.from(image.data, 'base64');
    let fd: number | undefined;
    let name = '';
    // 'wx' = O_CREAT|O_EXCL: never overwrites and never follows a planted symlink; retry on a lost race.
    for (; next <= 9999 && fd === undefined; next += 1) {
      name = `${next}.${ext}`;
      try {
        fd = openSync(path.join(dir, name), 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    if (fd === undefined) throw new Error('too many stored images for this session');
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off);
    } finally {
      closeSync(fd);
    }
    urls.push(`/api/sessions/${encodeURIComponent(sessionId)}/images/${name}`);
    paths.push(path.join(dir, name));
  }
  return { urls, paths };
}

/** Bytes of a stored image, or undefined when the name is invalid, missing, a symlink or too big. */
export function readImage(sessionId: string, name: string): { data: Buffer; contentType: string } | undefined {
  const file = resolveImagePath(sessionId, name);
  if (!file) return undefined;
  try {
    if (lstatSync(path.dirname(file)).isSymbolicLink()) return undefined;
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return undefined;
      const data = Buffer.alloc(st.size);
      let off = 0;
      while (off < data.length) {
        const n = readSync(fd, data, off, data.length - off, off);
        if (n === 0) break;
        off += n;
      }
      return { data: data.subarray(0, off), contentType: imageContentType(name) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Removes a session's images (best effort; a symlinked dir is unlinked, never followed). */
export function deleteImages(sessionId: string): void {
  if (!IMAGE_SESSION_RE.test(sessionId)) return;
  try {
    rmSync(imageDir(sessionId), { recursive: true, force: true });
  } catch {
    // Best effort: leftovers are private and small.
  }
}
