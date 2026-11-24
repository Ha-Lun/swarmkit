import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DirError, createDir, listDirs } from '../server/dirs.ts';

// Fixture lives under $HOME: the picker only ever lists directories inside it.
describe('listDirs', () => {
  let home: string;
  let fixture: string;

  beforeAll(async () => {
    home = await realpath(homedir());
    fixture = await mkdtemp(path.join(homedir(), 'fleet-dirs-'));
    await mkdir(path.join(fixture, 'Subdir'));
    await mkdir(path.join(fixture, '.hidden'));
    await mkdir(path.join(fixture, 'node_modules'));
    await mkdir(path.join(fixture, 'repo', '.git', 'refs'), { recursive: true });
    await writeFile(path.join(fixture, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(path.join(fixture, '.hiddenfile'), 'x');
    await symlink(path.join(home), path.join(fixture, 'link-inside')); // resolves to a dir inside home
    await symlink('/', path.join(fixture, 'link-out')); // resolves outside home: never listed
  });

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('defaults to $HOME, keeps only directories, sorts case-insensitively', async () => {
    const listing = await listDirs();
    expect(listing.path).toBe(home);
    expect(listing.parent).toBeUndefined(); // listing $HOME has no parent line
    // The temp fixture itself is a directory in $HOME.
    expect(listing.entries.map(e => e.name)).toContain(fixture.slice(home.length + 1));
    // Every listing is case-insensitively sorted.
    const names = listing.entries.map(e => e.name);
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(sorted);
  });

  it('lists the entry directories with isGitRepo and hides dotfiles and node_modules', async () => {
    const listing = await listDirs(fixture);
    const names = listing.entries.map(e => e.name);
    expect(names).toEqual(['link-inside', 'repo', 'Subdir']); // no .hidden, no node_modules, no link-out
    const repo = listing.entries.find(e => e.name === 'repo')!;
    expect(repo.isGitRepo).toBe(true);
    expect(repo.path).toBe(path.join(fixture, 'repo'));
    expect(listing.entries.find(e => e.name === 'link-inside')!.isGitRepo).toBe(false);
    expect(listing.parent).toBe(home);
  });

  it('shows dot directories when hidden=1 but never node_modules or escaping symlinks', async () => {
    const listing = await listDirs(fixture, true);
    const names = listing.entries.map(e => e.name);
    expect(names).toContain('.hidden');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('link-out');
  });

  it('refuses paths outside $HOME and nonexistent paths', async () => {
    await expect(listDirs('/etc')).rejects.toThrow('path must be inside your home directory');
    await expect(listDirs('/')).rejects.toThrow('path must be inside your home directory');
    await expect(listDirs('/no/such/dir-xyz')).rejects.toThrow('path does not exist');
    await expect(listDirs(path.join(fixture, 'link-out'))).rejects.toThrow('path must be inside your home directory');
    expect((await listDirs('/etc').catch(e => e)) instanceof DirError).toBe(true);
  });

  it('follows an in-home symlink for the target itself', async () => {
    const listing = await listDirs(path.join(fixture, 'link-inside'));
    expect(listing.path).toBe(home);
    expect(listing.parent).toBeUndefined(); // target === $HOME
  });
});

describe('createDir', () => {
  let fixture: string;

  beforeAll(async () => {
    fixture = await mkdtemp(path.join(homedir(), 'fleet-mkdir-'));
  });

  afterAll(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it('creates a folder inside home and returns its path', async () => {
    const res = await createDir(fixture, 'newfolder');
    expect(res.path).toBe(path.join(await realpath(fixture), 'newfolder'));
    expect((await stat(res.path)).isDirectory()).toBe(true);
  });

  it('accepts a Unicode name with spaces', async () => {
    const res = await createDir(fixture, 'Nytt projekt å');
    expect((await stat(res.path)).isDirectory()).toBe(true);
  });

  it('rejects reserved, dotted and empty names', async () => {
    for (const name of ['..', '.', '.hidden', '', '   ', 'a/b', 'a\\b']) {
      const err = await createDir(fixture, name).catch(e => e);
      expect(err instanceof DirError).toBe(true);
      expect(err.status).toBe(400);
    }
  });

  it('rejects control characters and overlong names', async () => {
    for (const name of ['a\x00b', 'a\nb', 'a\x7fb']) {
      const err = await createDir(fixture, name).catch(e => e);
      expect(err instanceof DirError).toBe(true);
      expect(err.status).toBe(400);
    }
    const long = 'x'.repeat(256);
    const err = await createDir(fixture, long).catch(e => e);
    expect(err instanceof DirError).toBe(true);
    expect(err.status).toBe(400);
  });

  it('rejects a non-string name and a non-string parent', async () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      const err = await createDir(fixture, bad).catch(e => e);
      expect(err instanceof DirError).toBe(true);
      expect(err.status).toBe(400);
    }
    for (const bad of [undefined, null, 42, {}, []]) {
      const err = await createDir(bad, 'ok').catch(e => e);
      expect(err instanceof DirError).toBe(true);
      expect(err.status).toBe(400);
    }
  });

  it('rejects a parent outside home', async () => {
    const err = await createDir('/etc', 'nope').catch(e => e);
    expect(err instanceof DirError).toBe(true);
    expect(err.status).toBe(400);
  });

  it('rejects a parent that is a symlink inside home pointing outside home', async () => {
    const link = path.join(fixture, 'link-out');
    await symlink('/', link);
    const err = await createDir(link, 'nope').catch(e => e);
    expect(err instanceof DirError).toBe(true);
    expect(err.status).toBe(400);
  });

  it('returns 409 when the folder already exists', async () => {
    await createDir(fixture, 'dup');
    const err = await createDir(fixture, 'dup').catch(e => e);
    expect(err instanceof DirError).toBe(true);
    expect(err.status).toBe(409);
    expect(String(err.message)).toMatch(/already exists/);
  });
});
