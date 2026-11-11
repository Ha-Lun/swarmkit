import { describe, expect, it } from 'vitest';
import { ASSETS_CACHE_CONTROL, INDEX_CACHE_CONTROL, staticPolicy } from '../server/static.ts';

describe('staticPolicy', () => {
  it('serves index.html with no-cache', () => {
    expect(staticPolicy('/index.html', true)).toEqual({
      status: 200,
      file: 'requested',
      cacheControl: INDEX_CACHE_CONTROL,
    });
    expect(INDEX_CACHE_CONTROL).toBe('no-cache');
  });

  it('maps / to the index fallback with no-cache', () => {
    expect(staticPolicy('/', false)).toEqual({
      status: 200,
      file: 'index',
      cacheControl: 'no-cache',
    });
  });

  it('serves hashed /assets/ output as immutable', () => {
    expect(staticPolicy('/assets/Markdown-Nc9eFraK.js', true)).toEqual({
      status: 200,
      file: 'requested',
      cacheControl: ASSETS_CACHE_CONTROL,
    });
    expect(ASSETS_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
  });

  it('404s missing /assets/ files instead of the SPA fallback', () => {
    expect(staticPolicy('/assets/Markdown-Nc9eFraK.js', false)).toEqual({ status: 404 });
  });

  it('falls back to index.html with no-cache for client routes', () => {
    expect(staticPolicy('/sessions/abc', false)).toEqual({
      status: 200,
      file: 'index',
      cacheControl: 'no-cache',
    });
  });

  it('serves other public files without an immutable header', () => {
    expect(staticPolicy('/icon.svg', true)).toEqual({ status: 200, file: 'requested' });
    expect(staticPolicy('/manifest.webmanifest', true)).toEqual({ status: 200, file: 'requested' });
    expect(staticPolicy('/fonts/inter.woff2', true)).toEqual({ status: 200, file: 'requested' });
  });
});
