// Chapter 3. Hex dissolve begins in the tail of the cells view and finishes in the head of this one; the lattice recedes and dims so the canvas never
// competes with the numbers. The DOM is a slim HUD strip of instrument readouts that come up one after another
// (opacity only) once the scene is pinned.
import { motion, recedeMix } from '../motion-config';
import { pinWindow, range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createProof(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('proof');
  const win = pinWindow(motion.runway.proof);
  const readouts = scene.q('[data-hud]');
  return {
    enter() {},
    fade: (v) => scene.fade(v),
    update(p) {
      const e = recedeMix(3, p); // one ease drives the dim, the canvas and the spin, and the rise out of the walk drives the same one (cells.ts)
      view.dim = e;
      view.canvasOpacity = 1 - (1 - motion.proof.canvasOpacity) * e;
      readouts.forEach((el, i) => setOpacity(el, range(p, win[0] * 0.7 + i * motion.hud.stagger, win[0] + 0.03 + i * motion.hud.stagger)));
    },
    exit() {
      scene.fade(0);
    },
  };
}
