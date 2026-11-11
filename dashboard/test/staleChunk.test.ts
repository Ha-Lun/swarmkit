import { describe, expect, it } from 'vitest';
import { isStaleChunkError } from '../src/client/App.tsx';

describe('isStaleChunkError', () => {
  it('matches failed dynamic imports', () => {
    expect(isStaleChunkError('Failed to fetch dynamically imported module: /assets/Markdown-Nc9eFraK.js')).toBe(
      true,
    );
    expect(isStaleChunkError('Importing a module script failed.')).toBe(true);
    expect(isStaleChunkError('error loading dynamically imported module')).toBe(true);
    expect(isStaleChunkError('Unable to preload CSS for /assets/style.css')).toBe(false);
  });

  it('rejects unrelated errors', () => {
    expect(isStaleChunkError('SwarmKit hit an error.')).toBe(false);
    expect(isStaleChunkError('NetworkError: fetch failed')).toBe(false);
    expect(isStaleChunkError('')).toBe(false);
  });
});
