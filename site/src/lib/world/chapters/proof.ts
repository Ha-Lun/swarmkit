// Chapter 3. Hex dissolve in from the end of the cells view; the lattice recedes and dims so the canvas never
// competes with the numbers. The DOM is a slim HUD strip of instrument readouts that come up one after another
// (opacity only) once the scene is pinned.
import { motion } from '../motion-config';
import { pinWindow, presence, range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

export function createProof(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('proof');
  const win = pinWindow(motion.runway.proof);
  const readouts = scene.q('[data-hud]');
  return {
    enter() {},
    update(p) {
      const m = motion.proof;
      view.dissolve = clamp01(p / m.dissolveEnd);
      view.dim = smooth(clamp01(p / m.dimEnd));
      view.canvasOpacity = 1 - (1 - m.canvasOpacity) * smooth(clamp01(p / m.dimEnd));
      scene.fade(presence(p, win));
      readouts.forEach((el, i) => setOpacity(el, range(p, win[0] * 0.7 + i * motion.hud.stagger, win[0] + 0.03 + i * motion.hud.stagger)));
    },
    exit() {
      scene.fade(0);
    },
  };
}
