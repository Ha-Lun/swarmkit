// Chapter 4. The lattice breaks apart (outer rings first) into the GPU particle swarm, which flocks and then
// assembles "./install.sh --all" as the attract blend rises with chapterProgress. The assembled command then holds
// centre screen. Only after it has formed do the copy button and the small chips (platforms, flags, counts) appear
// (opacity only, staggered).
// The last LOOP_VH of the runway is the homecoming (the page loops): the swarm lets go and fades, the lattice regrows from the core and the intro's wordmark fades in, while
// the world swings the camera back to the intro's rest pose (view.loop). It ends on exactly the frame the intro opens with, so the wrap of the scroll cannot be seen.
import { loopFrom, loopT, motion } from '../motion-config';
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';
import type { IntroChapter } from './intro';

export function createFinale(ctx: WorldCtx, intro: IntroChapter): Chapter {
  const { view } = ctx;
  const scene = sceneOf('install');
  const copy = scene.q('[data-copy-wrap]');
  const chips = scene.q('[data-chip-in]');
  return {
    enter() {},
    fade: (v) => scene.fade(v),
    update(pAll) {
      const f = motion.finale;
      const p = Math.min(1, pAll / loopFrom); // the finale proper runs on 0..1 as before; the homecoming comes after it
      const b = loopT(pAll);
      const broken = range(p, 0, f.breakEnd);
      const regrow = range(b, 0.3, 0.92); // the lattice comes back from the core outwards, brightening as it does
      view.dim = 1 - regrow;
      view.growth = 1 - broken + regrow; // growth runs the ring sweep backwards: outer rings go first
      view.latticeVisible = broken < 0.98 || regrow > 0.001;
      view.canvasOpacity = motion.proof.canvasOpacity + (1 - motion.proof.canvasOpacity) * range(p, f.opacityStart, f.opacityEnd);
      view.swarmFade = range(p, f.swarmInStart, f.swarmInEnd) * (1 - range(b, 0.15, 0.6));
      view.swarmAttract = range(p, f.attractStart, f.attractEnd) * (1 - range(b, 0, 0.5));
      view.loop = b;
      intro.preview(range(b, 0.6, 1));

      // the finale scene never leaves (the world fades it in with the handover); its parts come in on their own clocks
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
