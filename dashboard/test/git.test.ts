import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearGitCache, gitInfo } from '../server/git.ts';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

const tmpRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
}

async function makeTemp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fleet-git-'));
  tmpRoots.push(dir);
  return dir;
}

/** A temp repo with one committed file. */
async function makeRepo(): Promise<string> {
  const dir = await makeTemp();
  git(dir, 'init', '-b', 'main');
  await writeFile(path.join(dir, 'a.txt'), 'hello');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('gitInfo', () => {
  afterAll(async () => {
    clearGitCache();
    await Promise.all(tmpRoots.map(r => rm(r, { recursive: true, force: true })));
  });

  it('reports the branch name and dirty count', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'changed');
    await writeFile(path.join(dir, 'b.txt'), 'untracked');
    clearGitCache();
    const info = await gitInfo(dir);
    expect(info).toBeDefined();
    expect(info!.branch).toBe('main');
    expect(info!.detached).toBe(false);
    expect(info!.dirty).toBe(2); // one modified + one untracked
    expect(info!.ahead).toBe(0);
    expect(info!.behind).toBe(0);
    expect(info!.worktreeOf).toBeUndefined();
  });

  it('reports the short sha when HEAD is detached', async () => {
    const dir = await makeRepo();
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    git(dir, 'checkout', '--detach', sha);
    clearGitCache();
    const info = await gitInfo(dir);
    expect(info).toBeDefined();
    expect(info!.detached).toBe(true);
    expect(info!.branch).toBe(sha.slice(0, 7));
  });

  it('reports ahead/behind against a local upstream', async () => {
    const upstream = await makeTemp();
    git(upstream, 'init', '--bare');
    const dir = await makeRepo();
    git(dir, 'remote', 'add', 'origin', upstream);
    git(dir, 'push', '-u', 'origin', 'main');
    git(upstream, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    // One local commit the upstream lacks.
    await writeFile(path.join(dir, 'local.txt'), 'local');
    git(dir, 'add', 'local.txt');
    git(dir, 'commit', '-m', 'local');
    // One upstream commit the local lacks, via a fresh clone.
    const cloneParent = await makeTemp();
    const clone = path.join(cloneParent, 'clone');
    execFileSync('git', ['clone', upstream, clone], { env: GIT_ENV, encoding: 'utf8' });
    await writeFile(path.join(clone, 'remote.txt'), 'remote');
    git(clone, 'add', 'remote.txt');
    git(clone, 'commit', '-m', 'remote');
    git(clone, 'push', 'origin', 'HEAD:main');
    git(dir, 'fetch', 'origin');
    clearGitCache();
    const info = await gitInfo(dir);
    expect(info).toBeDefined();
    expect(info!.ahead).toBe(1);
    expect(info!.behind).toBe(1);
  });

  it('sets worktreeOf to the main checkout for a linked worktree', async () => {
    const dir = await makeRepo();
    const parent = await makeTemp();
    const wt = path.join(parent, 'wt');
    git(dir, 'worktree', 'add', wt, '-b', 'wt-branch');
    clearGitCache();
    const info = await gitInfo(await realpath(wt));
    expect(info).toBeDefined();
    expect(info!.worktreeOf).toBeDefined();
    expect(await realpath(info!.worktreeOf as string)).toBe(await realpath(dir));
  });

  it('returns undefined outside a repo', async () => {
    const dir = await makeTemp();
    clearGitCache();
    await expect(gitInfo(dir)).resolves.toBeUndefined();
  });

  it('caches results for 5 seconds', async () => {
    const dir = await makeRepo();
    clearGitCache();
    const first = await gitInfo(dir);
    expect(first!.dirty).toBe(0);
    // Change after the first call: the cached value still reports clean.
    await writeFile(path.join(dir, 'new.txt'), 'new');
    const second = await gitInfo(dir);
    expect(second!.dirty).toBe(0);
    clearGitCache();
    const third = await gitInfo(dir);
    expect(third!.dirty).toBe(1);
  });
});
