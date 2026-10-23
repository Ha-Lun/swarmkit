import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeConfigDir, liveHolder } from '../server/livesessions';

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
