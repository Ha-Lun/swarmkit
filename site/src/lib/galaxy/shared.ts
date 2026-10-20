// Small shared helpers for the galaxy page: render tier detection, the lane palette and a seeded RNG.
export type Tier = 'high' | 'medium' | 'low';

// Linear RGB 0..1: opus white-violet, opencode teal, agy amber.
export const PALETTE: {
  opus: [number, number, number];
  opencode: [number, number, number];
  agy: [number, number, number];
} = {
  opus: [0.694, 0.604, 1.0], // ~#d9ccff
  opencode: [0.027, 0.791, 0.578], // ~#2ee6c8
  agy: [1.0, 0.462, 0.063], // ~#ffb547
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** '?tier=high|medium|low|fallback' URL override first; 'fallback' if WebGL2 is unavailable; 'low' if innerWidth < 768
 *  or hardwareConcurrency <= 4; 'medium' if devicePixelRatio > 2 or innerWidth < 1200; else 'high'. The window is only
 *  touched inside this function, so importing this module during SSR is safe. */
export function detectTier(): Tier | 'fallback' {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'high';
  const m = /[?&]tier=(high|medium|low|fallback)/.exec(window.location.search);
  if (m) return m[1] as Tier | 'fallback';
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return 'fallback';
  } catch {
    return 'fallback';
  }
  const w = window.innerWidth || 0;
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 8;
  if (w < 768 || cores <= 4) return 'low';
  if ((window.devicePixelRatio || 1) > 2 || w < 1200) return 'medium';
  return 'high';
}
