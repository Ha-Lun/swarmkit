import { describe, expect, it } from 'vitest';
import { CHUNK_RELOAD_GUARD_MS, shouldReloadChunk } from '../src/client/chunkReload.ts';

describe('shouldReloadChunk', () => {
  it('reloads when never reloaded before', () => {
    expect(shouldReloadChunk(1_000, null)).toBe(true);
    expect(shouldReloadChunk(1_000, undefined)).toBe(true);
    expect(shouldReloadChunk(1_000, '')).toBe(true);
  });

  it('reloads for garbage stored values', () => {
    expect(shouldReloadChunk(1_000, 'not-a-number')).toBe(true);
  });

  it('skips the reload inside the guard window', () => {
    const now = 1_000_000;
    expect(shouldReloadChunk(now, String(now - 1_000))).toBe(false);
    expect(shouldReloadChunk(now, String(now - (CHUNK_RELOAD_GUARD_MS - 1)))).toBe(false);
  });

  it('reloads once the guard window has passed', () => {
    const now = 1_000_000;
    expect(CHUNK_RELOAD_GUARD_MS).toBe(10_000);
    expect(shouldReloadChunk(now, String(now - CHUNK_RELOAD_GUARD_MS))).toBe(true);
    expect(shouldReloadChunk(now, String(now - 60_000))).toBe(true);
  });
});
