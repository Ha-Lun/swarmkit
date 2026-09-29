// Quality tiers (PLAN §7.5). Small on purpose: this file is loaded on every visit, before three/gsap.
import { motion } from './motion-config';

export type PlayTier = 'high' | 'medium' | 'fallback';

export interface TierDecision {
  tier: PlayTier;
  reason: string;
  /** set by ?tier=...: the fps probe is skipped so a tier can be inspected as-is */
  forced: boolean;
}

const isTier = (v: string | null): v is PlayTier => v === 'high' || v === 'medium' || v === 'fallback';

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function decideTier(): TierDecision {
  const override = new URLSearchParams(location.search).get('tier');
  if (isTier(override)) return { tier: override, reason: `?tier=${override}`, forced: true };
  if (prefersReducedMotion()) return { tier: 'fallback', reason: 'prefers-reduced-motion', forced: false };
  if (typeof WebGL2RenderingContext === 'undefined') return { tier: 'fallback', reason: 'no WebGL2', forced: false };
  // desktop with enough cores starts high; everything else starts one step down (the probe can still lower it)
  const cores = navigator.hardwareConcurrency || 4;
  const coarse = matchMedia('(pointer: coarse)').matches;
  return { tier: cores >= 8 && !coarse ? 'high' : 'medium', reason: `${cores} cores${coarse ? ', coarse pointer' : ''}`, forced: false };
}

export function markTier(tier: PlayTier, reason: string) {
  document.documentElement.dataset.tier = tier;
  document.documentElement.dataset.tierReason = reason;
}

/**
 * ~1 s fps probe. Feed it frame deltas (ms); it calls back once with the tier to use.
 * Below 45 fps: one tier down (high -> medium). Below 30 fps: fallback. Medium at 30..45 stays.
 */
export function createFpsProbe(current: 'high' | 'medium', done: (next: PlayTier, fps: number) => void) {
  const { ms, warmupFrames, minFrames, stepDownBelow, fallbackBelow } = motion.probe;
  let seen = 0, frames = 0, elapsed = 0, finished = false;
  return (dtMs: number) => {
    if (finished) return;
    // (a hidden tab never reaches here: the world skips its frames and restarts its clock on return)
    if (++seen <= warmupFrames) return; // shader compile / first uploads
    frames++;
    elapsed += dtMs;
    if (elapsed < ms || frames < minFrames) return; // at very low fps the window stretches until there are enough frames
    finished = true;
    const fps = (frames * 1000) / elapsed;
    if (fps < fallbackBelow) done('fallback', fps);
    else if (fps < stepDownBelow && current === 'high') done('medium', fps);
    else done(current, fps);
  };
}
