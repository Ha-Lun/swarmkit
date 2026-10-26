// Cache / fallback policy for the production static server (see server/index.ts).
// Pure function so it can be unit-tested without starting the server.

export const INDEX_CACHE_CONTROL = 'no-cache';
export const ASSETS_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type StaticDecision =
  | { status: 200; file: 'requested' | 'index'; cacheControl?: string }
  | { status: 404 };

function isAssetsPath(pathname: string): boolean {
  return pathname === '/assets' || pathname.startsWith('/assets/');
}

/**
 * Decide what to serve for a static pathname.
 * @param pathname decoded URL pathname, with '/' already mapped to '/index.html' (mapping is also applied here for safety).
 * @param exists whether the resolved file exists on disk as a file.
 */
export function staticPolicy(pathname: string, exists: boolean): StaticDecision {
  const normalized = pathname === '/' ? '/index.html' : pathname;
  const isIndex = normalized === '/index.html';
  const isAssets = isAssetsPath(normalized);
  if (exists) {
    if (isIndex) return { status: 200, file: 'requested', cacheControl: INDEX_CACHE_CONTROL };
    if (isAssets) return { status: 200, file: 'requested', cacheControl: ASSETS_CACHE_CONTROL };
    return { status: 200, file: 'requested' };
  }
  // Missing file: stale hashed chunks under /assets/ must 404 (so the client
  // reloads instead of executing index.html as JS); everything else falls back
  // to the SPA entry, which itself is never cached.
  if (isAssets) return { status: 404 };
  return { status: 200, file: 'index', cacheControl: INDEX_CACHE_CONTROL };
}
