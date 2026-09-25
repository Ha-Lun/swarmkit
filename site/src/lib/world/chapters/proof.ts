// Chapter 3. Hex dissolve in from the end of the cells view; the lattice recedes and dims so the canvas never
// competes with the numbers.
import { motion } from '../motion-config';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

export function createProof(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  return {
    enter() {},
    update(p) {
      const m = motion.proof;
      view.dissolve = clamp01(p / m.dissolveEnd);
      view.dim = smooth(clamp01(p / m.dimEnd));
      view.canvasOpacity = 1 - (1 - m.canvasOpacity) * smooth(clamp01(p / m.dimEnd));
    },
    exit() {},
  };
}
