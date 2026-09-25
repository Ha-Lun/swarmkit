// Chapter 4. The lattice breaks apart (outer rings first) into the GPU particle swarm, which flocks and then
// assembles "./install.sh --all" as the attract blend rises with chapterProgress. The assembled command then holds
// centre screen. Only after it has formed do the copy button and the small chips (platforms, flags, counts) appear
// (opacity only, staggered).
import { motion } from '../motion-config';
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createFinale(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('install');
  const copy = scene.q('[data-copy-wrap]');
  const chips = scene.q('[data-chip-in]');
  return {
    enter() {},
    update(p) {
      const f = motion.finale;
      const broken = range(p, 0, f.breakEnd);
      view.dim = 1;
      view.growth = 1 - broken; // growth runs the ring sweep backwards: outer rings go first
      view.latticeVisible = broken < 0.98;
      view.canvasOpacity = motion.proof.canvasOpacity + (1 - motion.proof.canvasOpacity) * range(p, f.opacityStart, f.opacityEnd);
      view.swarmFade = range(p, f.swarmInStart, f.swarmInEnd);
      view.swarmAttract = range(p, f.attractStart, f.attractEnd);

      scene.fade(1); // the finale scene never leaves; its parts come in on their own clocks
      copy.forEach((el) => setOpacity(el, range(p, f.copyStart, f.copyEnd)));
      const n = Math.max(1, chips.length);
      const span = (f.chipsEnd - f.chipsStart) * 0.6; // each chip takes 60% of the window; starts are staggered across the rest
      chips.forEach((el, i) => {
        const a = f.chipsStart + ((f.chipsEnd - f.chipsStart - span) * i) / Math.max(1, n - 1);
        setOpacity(el, range(p, a, a + span));
      });
    },
    exit() {
      scene.fade(0);
    },
  };
}
