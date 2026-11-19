// refreshHolders() must serialize its runs: a slow out-of-order registry read must
// never overwrite a newer snapshot without diffing it (that would silently drop a
// holder). The live-registry read is mocked with hand-resolved promises here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptWatcher } from '../server/watch/transcripts.ts';
import type { ServerEvent } from '../src/shared/types.ts';

type Holders = Map<string, { pid: number; status?: string }>;

/** The controlled live-registry read each refreshHolders run takes, in order. */
const pendingReads: Array<(holders: Holders) => void> = [];

vi.mock('../server/livesessions.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/livesessions.ts')>();
  return {
    ...actual,
    liveHolders: () => new Promise<Holders>(resolve => pendingReads.push(resolve)),
  };
});

const temps: string[] = [];
afterEach(() => {
  pendingReads.length = 0;
  for (const base of temps.splice(0)) rmSync(base, { recursive: true, force: true });
});

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('condition not met');
}

describe('refreshHolders serialization', () => {
  it('a queued second run re-reads after the first: no holder is lost', async () => {
    const base = mkdtempSync(path.join(homedir(), 'fleet-watch-serial-'));
    temps.push(base);
    const projects = path.join(base, 'projects');
    mkdirSync(projects, { recursive: true });
    const events: ServerEvent[] = [];
    const w = new TranscriptWatcher({ root: projects, emit: e => events.push(e), skip: () => false });
    const internals = w as unknown as {
      refreshHolders(): Promise<void>;
      holders: Holders;
    };

    // Two concurrent refreshes: A takes the first read, B queues behind it.
    const first = internals.refreshHolders();
    const second = internals.refreshHolders();
    await until(() => pendingReads.length === 1);

    // A's read resolves with a stale empty registry.
    pendingReads.shift()!(new Map());
    await first;
    expect(internals.holders.size).toBe(0);
    // Only now does B take its read — with the fresh data naming a holder.
    await until(() => pendingReads.length === 1);
    pendingReads.shift()!(new Map([['held-x', { pid: 1, status: 'idle' }]]));
    await second;

    // The holder survived both runs (an unserialized pair would have overwritten
    // it with A's stale empty snapshot after B had stored it).
    expect(internals.holders.get('held-x')).toBeDefined();
    w.stop();
  });
});
