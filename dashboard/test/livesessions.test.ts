import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeConfigDir, liveHolder, liveHolders } from '../server/livesessions';

const base = mkdtempSync(path.join(homedir(), 'fleet-livesessions-test-'));
const dir = path.join(base, 'sessions');
mkdirSync(dir);
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PID_FILE = path.join(dir, '999.json');

function writeHolder(overrides: Record<string, unknown>): void {
  writeFileSync(
    PID_FILE,
    JSON.stringify({
      pid: process.pid, // this process is alive, so the default probe reports it
      sessionId: 'live-1',
      cwd: homedir(),
      kind: 'interactive',
      entrypoint: 'cli',
      status: 'busy',
      ...overrides,
    }),
  );
}

describe('liveHolder', () => {
  it('finds a matching live holder from the sessions dir', async () => {
    writeHolder({});
    const holder = await liveHolder('live-1', { dir });
    expect(holder).toEqual({
      pid: process.pid,
      kind: 'interactive',
      status: 'busy',
      entrypoint: 'cli',
    });
  });

  it('ignores a dead pid (injected isAlive) and honors an injected alive probe', async () => {
    writeHolder({ pid: 4_242_424 });
    expect(await liveHolder('live-1', { dir, isAlive: () => false })).toBeUndefined();
    const holder = await liveHolder('live-1', { dir, isAlive: pid => pid === 4_242_424 });
    expect(holder?.pid).toBe(4_242_424); // the pid itself need not be ours: probes decide
  });

  it('ignores *.key files and unparseable *.json files', async () => {
    writeHolder({});
    writeFileSync(path.join(dir, '777.key'), '{"pid":1,"sessionId":"live-1"}');
    writeFileSync(path.join(dir, '888.json'), '{not json at all');
    expect(await liveHolder('live-1', { dir, isAlive: () => false })).toBeUndefined();
    // The well-formed file still wins over the noise.
    const holder = await liveHolder('live-1', { dir, isAlive: () => true });
    expect(holder?.pid).toBe(process.pid);
  });

  it('ignores records for other session ids and missing dirs', async () => {
    writeHolder({});
    expect(await liveHolder('live-2', { dir, isAlive: () => true })).toBeUndefined();
    rmSync(PID_FILE);
    expect(await liveHolder('live-1', { dir, isAlive: () => true })).toBeUndefined();
    expect(await liveHolder('live-1', { dir: path.join(dir, 'missing'), isAlive: () => true })).toBeUndefined();
  });

  it('defaults dir to CLAUDE_CONFIG_DIR (or ~/.claude) + sessions', () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    try {
      delete process.env.CLAUDE_CONFIG_DIR;
      expect(claudeConfigDir()).toBe(path.join(homedir(), '.claude'));
      process.env.CLAUDE_CONFIG_DIR = base;
      expect(claudeConfigDir()).toBe(base);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
    }
  });
});

describe('liveHolders', () => {
  const bulkDir = path.join(base, 'sessions-bulk');
  const bulkFile = path.join(bulkDir, `${process.pid}.json`);

  /** Bulk read against an explicit dir: see the cached default-dir behavior separately. */
  it('maps session ids to {pid,status} and filters dead/invalid records', async () => {
    mkdirSync(bulkDir, { recursive: true });
    writeFileSync(bulkFile, JSON.stringify({
      pid: process.pid, // alive via the default probe
      sessionId: 'bulk-1',
      status: 'busy',
      kind: 'interactive',
      entrypoint: 'cli',
    }));
    writeFileSync(path.join(bulkDir, '888.json'), '{not json');
    writeFileSync(path.join(bulkDir, '999.json'), JSON.stringify({ pid: process.pid, sessionId: '', status: 'busy' }));
    writeFileSync(path.join(bulkDir, '1000.json'), JSON.stringify({ pid: process.pid, sessionId: 'bulk-2', status: 'idle' }));
    const holders = await liveHolders({ dir: bulkDir });
    expect(holders.get('bulk-1')).toMatchObject({ pid: process.pid, status: 'busy' });
    expect(holders.get('bulk-2')).toMatchObject({ pid: process.pid, status: 'idle' });
    expect(holders.size).toBe(2);
  });

  it('caches the default dir (2 s TTL) and re-reads when the dir changed', async () => {
    const cacheBase = mkdtempSync(path.join(homedir(), 'fleet-livesessions-bulk-'));
    const sessions = path.join(cacheBase, 'sessions');
    mkdirSync(sessions);
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cacheBase;
    try {
      writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: 'cache-1', status: 'busy',
      }));
      const first = await liveHolders();
      expect(first.get('cache-1')?.status).toBe('busy');
      // No dir change in between (TTL window): the very same cached map comes back.
      const second = await liveHolders();
      expect(second).toBe(first);
      // A new holder file changes the dir mtime: the cache is invalidated immediately.
      writeFileSync(path.join(sessions, '555.json'), JSON.stringify({
        pid: process.pid, sessionId: 'cache-2', status: 'idle',
      }));
      const third = await liveHolders();
      expect(first.has('cache-2')).toBe(false); // the cached snapshot did not know it
      expect(third.get('cache-2')?.status).toBe('idle');
      // An explicit dir/probe bypasses the cache entirely.
      rmSync(path.join(sessions, '555.json'));
      expect(await liveHolders({ dir: sessions, isAlive: (pid) => pid === process.pid })).not.toBe(first);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      rmSync(cacheBase, { recursive: true, force: true });
    }
  });

  it('keeps the first record for a session id even if it is not a live holder', async () => {
    // liveHolder keeps the first ALIVE record; the bulk map does the same.
    const tieDir = path.join(base, 'sessions-tie');
    mkdirSync(tieDir, { recursive: true });
    writeFileSync(path.join(tieDir, 'a.json'), JSON.stringify({ pid: 0, sessionId: 'tie', status: 'idle' }));
    writeFileSync(path.join(tieDir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'tie', status: 'busy' }));
    const holders = await liveHolders({ dir: tieDir });
    expect(holders.get('tie')?.status).toBe('busy'); // the dead record (pid 0) was skipped
  });
});
