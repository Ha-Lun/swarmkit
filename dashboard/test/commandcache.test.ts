// Command cache: exact cwd first, per-runtime fallback, persistence across instances, cap.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandCache } from '../server/commandcache.ts';

const cmd = (name: string) => ({ name, description: '' });
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('CommandCache', () => {
  it('returns the exact cwd list, else the most recent list of the same runtime only', () => {
    const c = new CommandCache();
    expect(c.get('claude', '/a')).toEqual([]);
    c.set('claude', '/a', [cmd('alpha')]);
    c.set('claude', '/b', [cmd('beta')]);
    expect(c.get('claude', '/a').map(x => x.name)).toEqual(['alpha']);
    expect(c.get('claude', '/elsewhere').map(x => x.name)).toEqual(['beta']);
    expect(c.get('opencode', '/a')).toEqual([]);
    expect(c.has('claude', '/elsewhere')).toBe(false);
  });

  it('survives a restart through the file (0600) and caps at 50 entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cmdcache-'));
    dirs.push(dir);
    const file = path.join(dir, 'swarmkit', 'commands.json');
    const a = new CommandCache(file);
    for (let i = 0; i < 55; i++) a.set('claude', `/p${i}`, [cmd(`c${i}`)]);
    await new Promise(r => setTimeout(r, 100));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(await readFile(file, 'utf8')))).toHaveLength(50);
    const b = new CommandCache(file);
    expect(b.get('claude', '/p54').map(x => x.name)).toEqual(['c54']);
    expect(b.has('claude', '/p0')).toBe(false);
    expect(b.get('claude', '/new').map(x => x.name)).toEqual(['c54']);
  });

  it('ignores a corrupt file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cmdcache-'));
    dirs.push(dir);
    const file = path.join(dir, 'commands.json');
    await (await import('node:fs/promises')).writeFile(file, '{not json');
    expect(new CommandCache(file).get('claude', '/a')).toEqual([]);
  });
});
