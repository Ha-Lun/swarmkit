import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitInfo } from '../src/shared/types.ts';

const run = promisify(execFile);
// Polling must never take the index lock from the lead's or a worker's own git commands, and the repo's own
// config must not make a status poll run a program (core.fsmonitor).
const execFileAsync = (cmd: string, args: string[], opts: { timeout: number }) =>
  run(cmd, [args[0] as string, args[1] as string, '-c', 'core.fsmonitor=false', ...args.slice(2)], {
    ...opts,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
/** Cache TTL for gitInfo results (and failures) per cwd. */
const CACHE_MS = 5000;

interface CacheEntry {
  at: number;
  value: GitInfo | undefined;
  promise: Promise<GitInfo | undefined> | null;
}

const cache = new Map<string, CacheEntry>();

export function clearGitCache(): void {
  cache.clear();
}

async function fetchGitInfo(cwd: string): Promise<GitInfo | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'status', '--porcelain=v2', '--branch'], {
      timeout: 2000,
    });
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
      const { stdout: rp } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--git-dir', '--git-common-dir'], {
        timeout: 2000,
      });
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

export async function gitInfo(cwd: string): Promise<GitInfo | undefined> {
  const hit = cache.get(cwd);
  if (hit) {
    // In-flight call: share it instead of spawning a second git.
    if (hit.promise) return hit.promise;
    if (Date.now() - hit.at < CACHE_MS) return hit.value;
  }
  const entry: CacheEntry = { at: Date.now(), value: undefined, promise: null };
  entry.promise = fetchGitInfo(cwd).then(value => {
    entry.at = Date.now();
    entry.value = value;
    entry.promise = null;
    return value;
  });
  cache.set(cwd, entry);
  return entry.promise;
}
