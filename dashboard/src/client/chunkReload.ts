// Guard for the `vite:preloadError` auto-reload (see main.tsx).
// Pure helper so it can be unit-tested without a DOM.

/** sessionStorage key holding the last auto-reload timestamp (ms since epoch). */
export const CHUNK_RELOAD_KEY = 'swarmkit.chunk-reload-at';
/** Minimum time between auto-reloads; skips the reload when crossed too soon. */
export const CHUNK_RELOAD_GUARD_MS = 10_000;

/**
 * Return true when the page should reload now.
 * @param now current time in ms (e.g. Date.now()).
 * @param stored raw sessionStorage value, or null/undefined when never reloaded.
 */
export function shouldReloadChunk(now: number, stored: string | null | undefined): boolean {
  if (stored == null || stored === '') return true;
  const last = Number(stored);
  if (!Number.isFinite(last)) return true;
  return now - last >= CHUNK_RELOAD_GUARD_MS;
}
