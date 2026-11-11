import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitInfo } from '../src/shared/types.ts';

const run = promisify(execFile);
/** Cache TTL for gitInfo results (and failures) per cwd. */
const CACHE_MS = 5000;

// Polling must never take the index lock from the lead's or a worker's own git commands, and the repo's own
// config must not make a status poll run a program (core.fsmonitor).
const git = (cwd: string, ...args: string[]) =>
  run('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    timeout: 2000,
    killSignal: 'SIGKILL',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

/** One entry per cwd; the promise is shared by concurrent callers and never rejects. */
const cache = new Map<string, { at: number; promise: Promise<GitInfo | undefined> }>();

export function clearGitCache(): void {
  cache.clear();
}

async function fetchGitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const { stdout } = await git(cwd, 'status', '--porcelain=v2', '--branch');
    let head = '';
    let oid = '';
    let ahead = 0;
    let behind = 0;
    let dirty = 0;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) {
        head = line.slice('# branch.head '.length).trim();
      } else if (line.startsWith('# branch.oid ')) {
        oid = line.slice('# branch.oid '.length).trim();
      } else if (line.startsWith('# branch.ab ')) {
        const m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line);
        if (m) {
          ahead = Number(m[1]);
          behind = Number(m[2]);
        }
      } else if (line.length > 0 && !line.startsWith('#')) {
        dirty += 1;
      }
    }
    const detached = head === '(detached)';
    const branch = detached ? oid.slice(0, 7) : head;
    if (!branch) return undefined;
    const info: GitInfo = { branch, detached, dirty, ahead, behind };
    try {
      const { stdout: rp } = await git(cwd, 'rev-parse', '--git-dir', '--git-common-dir');
      const lines = rp
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        const resolveGitPath = (p: string): string =>
          path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
        const gitDir = resolveGitPath(lines[0] as string);
        const commonDir = resolveGitPath(lines[1] as string);
        if (gitDir !== commonDir) {
          info.worktreeOf = path.dirname(commonDir);
        }
      }
    } catch {
      // Worktree detection is best-effort; keep the status info without it.
    }
    return info;
  } catch {
    return undefined;
  }
}

export function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const entry = { at: Date.now(), promise: fetchGitInfo(cwd) };
  cache.set(cwd, entry);
  return entry.promise;
}
