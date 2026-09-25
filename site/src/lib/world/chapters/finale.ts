// Chapter 4. The lattice breaks apart (outer rings first) into the GPU particle swarm, which flocks and then
// assembles "./install.sh --all" as the attract blend rises with chapterProgress. Afterwards the swarm recedes
// so the install copy stays legible.
import { motion } from '../motion-config';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const range = (p: number, a: number, b: number) => smooth(clamp01((p - a) / (b - a)));

export function createFinale(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  return {
    enter() {},
    update(p) {
      const f = motion.finale;
      const broken = range(p, 0, f.breakEnd);
      view.dim = 1;
      view.growth = 1 - broken; // growth runs the ring sweep backwards: outer rings go first
      view.latticeVisible = broken < 0.98;
      view.canvasOpacity = motion.proof.canvasOpacity + (1 - motion.proof.canvasOpacity) * range(p, f.opacityStart, f.opacityEnd);
      view.swarmFade = range(p, f.swarmInStart, f.swarmInEnd) * (1 - (1 - f.fadeBackTo) * range(p, f.fadeBackStart, f.fadeBackEnd));
      view.swarmAttract = range(p, f.attractStart, f.attractEnd);
    },
    exit() {},
  };
}
