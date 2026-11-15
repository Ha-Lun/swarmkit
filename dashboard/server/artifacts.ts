// Artifact store: files an agent hands the user, ${XDG_CACHE_HOME || ~/.cache}/swarmkit/artifacts/<sessionId>/.
// Page sessions get the dir as $SWARMKIT_ARTIFACTS_DIR. Private (dir 0700, no symlinks followed).
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IMAGE_SESSION_RE } from './images.ts';

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
