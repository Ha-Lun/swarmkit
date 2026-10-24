// Starred folders: add, list, remove, validation, persistence and the 50-entry cap.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DirError } from '../server/dirs.ts';
import { listStars, setStar, starsFilePath } from '../server/stars.ts';

// Storage lives under $XDG_CONFIG_HOME (read at call time); the starred dirs
// themselves must lie under the real $HOME, like the folder picker.
describe('stars', () => {
  let home: string;
  let configDir: string;
  let dirA: string;
  let dirB: string;
  let previousXdg: string | undefined;

  beforeAll(async () => {
    home = await realpath(homedir());
    configDir = await mkdtemp(path.join(tmpdir(), 'fleet-stars-config-'));
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDir;
    dirA = await mkdtemp(path.join(home, 'fleet-star-a-'));
    dirB = await mkdtemp(path.join(home, 'fleet-star-b-'));
  });

  afterAll(async () => {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    await rm(configDir, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  it('starts empty and adds then lists a folder', async () => {
    expect(await listStars()).toEqual([]);
    expect(await setStar(dirA, true)).toEqual([await realpath(dirA)]);
    expect(await listStars()).toEqual([await realpath(dirA)]);
  });

  it('dedupes repeat stars and removes on unstar', async () => {
    expect(await setStar(dirA, true)).toEqual([await realpath(dirA)]);
    expect(await setStar(dirB, true)).toEqual([await realpath(dirA), await realpath(dirB)]);
    expect(await setStar(dirB, false)).toEqual([await realpath(dirA)]);
    expect(await setStar(dirA, false)).toEqual([]);
  });

  it('rejects paths outside $HOME and nonexistent paths with a 400', async () => {
    const outside = await setStar('/etc', true).catch(e => e);
    expect(outside instanceof DirError).toBe(true);
    expect((outside as DirError).status).toBe(400);
    const missing = await setStar(path.join(home, 'no-such-dir-xyz'), true).catch(e => e);
    expect(missing instanceof DirError).toBe(true);
    expect((missing as DirError).status).toBe(400);
    expect(await listStars()).toEqual([]);
  });

  it('drops folders that no longer exist from listStars', async () => {
    const gone = await mkdtemp(path.join(home, 'fleet-star-gone-'));
    await setStar(gone, true);
    expect(await listStars()).toContain(await realpath(gone));
    await rm(gone, { recursive: true, force: true });
    expect(await listStars()).toEqual([]);
  });

  it('treats missing or corrupt storage as empty', async () => {
    await rm(starsFilePath(), { force: true });
    expect(await listStars()).toEqual([]);
    await mkdir(path.dirname(starsFilePath()), { recursive: true });
    await writeFile(starsFilePath(), 'not json{{{');
    expect(await listStars()).toEqual([]);
    await writeFile(starsFilePath(), '{"stars": []}');
    expect(await listStars()).toEqual([]);
  });

  it('refuses to star more than 50 folders', async () => {
    const dirs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const d = await mkdtemp(path.join(home, `fleet-star-cap-${i}-`));
      dirs.push(d);
      await setStar(d, true);
    }
    expect(await listStars()).toHaveLength(50);
    const extra = await mkdtemp(path.join(home, 'fleet-star-cap-extra-'));
    dirs.push(extra);
    const rejected = await setStar(extra, true).catch(e => e);
    expect(rejected instanceof DirError).toBe(true);
    expect((rejected as DirError).status).toBe(400);
    expect((rejected as Error).message).toBe('too many starred folders');
    // Removing one frees a slot again.
    await setStar(dirs[0]!, false);
    expect(await setStar(extra, true)).toContain(await realpath(extra));
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    await rm(starsFilePath(), { force: true });
  });

  it('hides a stored dir outside $HOME', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'fleet-stars-outside-'));
    try {
      const outsideReal = await realpath(outside);
      await mkdir(path.dirname(starsFilePath()), { recursive: true });
      await writeFile(starsFilePath(), JSON.stringify([outsideReal]));
      expect(await listStars()).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
      await rm(starsFilePath(), { force: true });
    }
  });

  it('unstarring a deleted folder removes it from the file', async () => {
    const gone = await mkdtemp(path.join(home, 'fleet-star-unstar-gone-'));
    const goneReal = await realpath(gone);
    await setStar(goneReal, true);
    await rm(gone, { recursive: true, force: true });
    expect(await listStars()).toEqual([]);
    expect(await setStar(goneReal, false)).toEqual([]);
    const raw = await readFile(starsFilePath(), 'utf8');
    expect(JSON.parse(raw)).not.toContain(goneReal);
    await rm(starsFilePath(), { force: true });
  });

  it('stale entries do not count toward the 50-folder cap', async () => {
    const stale = Array.from({ length: 50 }, (_, i) => path.join(home, `fleet-star-stale-missing-${i}-xyz`));
    await mkdir(path.dirname(starsFilePath()), { recursive: true });
    await writeFile(starsFilePath(), JSON.stringify(stale));
    const fresh = await mkdtemp(path.join(home, 'fleet-star-fresh-'));
    try {
      expect(await setStar(fresh, true)).toEqual([await realpath(fresh)]);
    } finally {
      await rm(fresh, { recursive: true, force: true });
      await rm(starsFilePath(), { force: true });
    }
  });

  it('leaves no temp files behind after setStar', async () => {
    await rm(starsFilePath(), { force: true });
    await setStar(dirA, true);
    await setStar(dirA, false);
    const entries = await readdir(path.dirname(starsFilePath()));
    expect(entries.filter(f => f.endsWith('.tmp'))).toEqual([]);
    await rm(starsFilePath(), { force: true });
  });
});
