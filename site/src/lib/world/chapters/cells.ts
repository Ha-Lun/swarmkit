// Chapter 2. The camera flies along the lattice (camera-path.ts). Hovering a cell, or focusing its entry in the
// hidden agent list, lifts and brightens it and shows its label card (pick.ts). No roster panels: the roster lives in
// the Reference section. The tier legend chip of the active agent's band lights (opacity only).
import { Vector3 } from 'three';
import { dissolveMix, motion } from '../motion-config';
import { createPick } from '../pick';
import { sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createCells(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('cells');
  const pick = createPick(ctx, scene.root);
  const tmp = new Vector3();
  const bandOf = new Map(ctx.agents.map((a) => [a.name, a.band as string]));
  const legend = new Map(scene.q('[data-legend]').map((e) => [e.dataset.legend!, e.querySelector<HTMLElement>('.chip-ring')!]));

  return {
    enter() {
      pick.enable();
    },
    fade: (v) => scene.fade(v),
    update(p) {
      // the tail of the fly-over already carries the first part of the Cells -> Proof dissolve (proof.ts carries the rest)
      const e = dissolveMix(2, p);
      view.dissolve = e;
      view.dim = e;
      view.canvasOpacity = 1 - (1 - motion.proof.canvasOpacity) * e;
      const { name, byKeyboard } = pick.update();
      if (name && ctx.cellTop(name, tmp)) {
        ctx.hilite(name, 1);
        if (byKeyboard) { // a keyboard-focused cell may be off screen: ease the camera toward it. A hovered one never moves the camera.
          view.focus.copy(tmp);
          view.focusWeight = motion.camera.hoverBias;
        }
      }
      const band = name ? bandOf.get(name) : null;
      legend.forEach((ring, b) => setOpacity(ring, b === band ? 1 : 0));
    },
    exit() {
      pick.disable();
      legend.forEach((ring) => setOpacity(ring, 0));
      scene.fade(0);
    },
    dispose() {
      pick.dispose();
    },
  };
}
