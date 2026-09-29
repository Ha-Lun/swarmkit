// Chapter 2. The camera flies along the lattice (camera-path.ts). Hovering a cell, or focusing its entry in the
// hidden agent list, lifts and brightens it and shows its label card (pick.ts). No roster panels: the roster lives in
// the Reference section. The tier legend chip of the active agent's band lights (opacity only).
import { Vector3 } from 'three';
import { nearestTowerAhead, type TowerRef } from '../walk';
import { createWalkLook } from '../walk-look';
import { motion, recedeMix } from '../motion-config';
import { createPick } from '../pick';
import { sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createCells(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('cells');
  const pick = createPick(ctx, scene.root);
  const tmp = new Vector3();
  // the walk: the tower the walker is heading for shows its card (pointer hover and keyboard focus still win)
  const towers: TowerRef[] = ctx.lattice.cells.filter((c) => c.agent && !c.moon).map((c) => ({ name: c.agent!.name, top: new Vector3() }));
  const fwd = new Vector3();
  let ahead: string | null = null;
  const look = createWalkLook(); // drag to look around while walking
  const bandOf = new Map(ctx.agents.map((a) => [a.name, a.band as string]));
  const legend = new Map(scene.q('[data-legend]').map((e) => [e.dataset.legend!, e.querySelector<HTMLElement>('.chip-ring')!]));

  return {
    enter() {
      pick.enable();
      look.enable();
    },
    fade: (v) => scene.fade(v),
    update(p) {
      // the rise out of the walk already carries the pull-back that dims the globe into the Proof view (proof.ts carries the rest): one ease, no dissolve
      const e = recedeMix(2, p);
      view.dim = e;
      view.canvasOpacity = 1 - (1 - motion.proof.canvasOpacity) * e;
      look.step(ctx.dt, view.walk > 0.85, view.walk);
      view.lookYaw = look.yaw;
      view.lookPitch = look.pitch;
      const walking = view.walk > 0.05;
      if (view.walk > 0.85) { // cards only once the camera is on the ground (not mid-dive)
        towers.forEach((t) => ctx.cellTop(t.name, t.top));
        fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        ahead = nearestTowerAhead(towers, ctx.camera.position, fwd, ctx.lattice.radius, ahead);
      } else ahead = null;
      const { name, byKeyboard, byWalk } = pick.update({ strict: walking, forced: ahead });
      if (name && ctx.cellTop(name, tmp)) {
        ctx.hilite(name, byWalk ? 0.6 : 1);
        if (byKeyboard && !walking) { // a keyboard-focused cell may be off screen: ease the camera toward it (never on the walk: there the camera is the walker's, and focus only shows the card and highlight). A hovered one never moves the camera.
          view.focus.copy(tmp);
          view.focusWeight = motion.camera.hoverBias;
        }
      }
      const band = name ? bandOf.get(name) : null;
      legend.forEach((ring, b) => setOpacity(ring, b === band ? 1 : 0));
    },
    exit() {
      pick.disable();
      look.disable();
      view.lookYaw = view.lookPitch = 0;
      legend.forEach((ring) => setOpacity(ring, 0));
      scene.fade(0);
    },
    dispose() {
      pick.dispose();
      look.disable();
    },
  };
}
