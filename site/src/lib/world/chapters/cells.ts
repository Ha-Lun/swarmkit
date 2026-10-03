// Chapter 2. The task's journey: the camera follows the comet in and from tower to tower (follow.ts), and the steps are called out while the comet is at them: the current step's caption shows and
// its chip lights and fills (all pre-rendered from the routing data, only opacity and a scale are written). Hovering a cell, or focusing its entry in the hidden agent list, lifts and
// brightens it and shows its label card (pick.ts). No roster panels: the roster lives in the Reference section.
import { Vector3 } from 'three';
import { nearestTowerAhead, type TowerRef } from '../walk';
import { createWalkLook } from '../walk-look';
import { aerial, motion, recedeMix, walkCfg, walkUOf } from '../motion-config';
import { createPick } from '../pick';
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createCells(ctx: WorldCtx): Chapter {
  const { view, routing } = ctx;
  const scene = sceneOf('cells');
  const pick = createPick(ctx, scene.root);
  const tmp = new Vector3();
  // the walk: the tower the walker is heading for shows its card (pointer hover and keyboard focus still win)
  const towers: TowerRef[] = ctx.lattice.cells.filter((c) => c.agent && !c.moon).map((c) => ({ name: c.agent!.name, top: new Vector3() }));
  const towerByName = new Map(towers.map((t) => [t.name, t]));
  const fwd = new Vector3();
  let ahead: string | null = null;
  // the steps: every journey's captions and chips are in the page; the active journey's current one is shown
  const captions = scene.q('[data-caption-step]').map((el) => ({ el, j: Number(el.dataset.j), b: el.dataset.b === undefined ? -1 : Number(el.dataset.b) }));
  const chipLists = scene.q('[data-steps]').map((el) => ({
    el, j: Number(el.dataset.steps),
    chips: [...el.querySelectorAll<HTMLElement>('[data-step]')].map((c) => ({ ring: c.querySelector<HTMLElement>('.chip-ring')!, fill: c.querySelector<HTMLElement>('.chip-fill')!, b: Number(c.dataset.b), last: -1 })),
  }));
  const EPS = 0.012; // the crossfade between two steps, in route parameter (and in Cells progress for the gates)
  const win = (x: number, a: number, b: number) => range(x, a - EPS, a + EPS) * (1 - range(x, b - EPS, b + EPS));
  const look = createWalkLook(); // drag to look around while walking

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
      const route = ctx.walkRoute;
      const u = walkUOf(p);
      // the steps: where each step's window is in the journey (a stop's hold is shared by the steps shown at it; the gates run together once the camera has risen)
      const jr = routing.journeys[view.journey];
      const stops = route?.stops;
      const windowOf = (bi: number): [number, number] => { // [start, end] in route parameter, or in Cells progress for a gate
        const b = jr.beats[bi];
        if (b.stop < 0) return [aerial.fanFrom - 0.02, aerial.gateFadeOut[1]];
        const s = stops![b.stop], slot = (s.u1 - s.u0) / b.of, w0 = s.u0 + slot * b.k;
        return [bi === 0 ? -1 : w0, w0 + slot];
      };
      const uNow = (view.walkCp - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom); // (unclamped: the classification step shows from the launch)
      const posOf = (bi: number) => (jr.beats[bi].stop < 0 ? p : uNow);
      const weightOf = (bi: number) => { const [a, b] = windowOf(bi); return win(posOf(bi), a, b); };
      if (stops && jr) {
        const gateBeat = jr.beats.findIndex((b) => b.stop < 0);
        captions.forEach((c) => setOpacity(c.el, c.j !== view.journey ? 0 : weightOf(c.b >= 0 ? c.b : gateBeat)));
        chipLists.forEach((l) => {
          setOpacity(l.el, l.j === view.journey ? 1 : 0);
          if (l.j !== view.journey) return;
          l.chips.forEach((c) => {
            const [a, b] = windowOf(c.b), xv = posOf(c.b);
            setOpacity(c.ring, win(xv, a, b));
            const v = Math.round(Math.min(1, Math.max(0, (xv - Math.max(a, 0)) / (b - Math.max(a, 0)))) * 500) / 500;
            if (v !== c.last) { c.last = v; c.fill.style.transform = `scaleX(${v})`; }
          });
        });
      }
      // the aerial: the camera rises to the whole-globe view for the gates and returns for the Proof pull-back
      view.overview = range(p, aerial.overviewIn[0], aerial.overviewIn[1]) * (1 - range(p, aerial.overviewOut[0], aerial.overviewOut[1]));
      ctx.comet.update(route, (view.walkCp - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom), view.walk, view.walkCp); // (unclamped: the comet comes down with the dive and stays until the rise)
      const stop = route?.stops[view.walkStop];
      const dwelling = stop && u >= stop.u0 && u <= stop.u1 ? stop.name : null; // holding at this tower
      if (view.walk > 0.85) { // the card of the tower the comet is heading for (or resting on), once the camera is in the low orbit (not mid-dive), unless you have turned your head away from it
        const lookedAway = Math.abs(look.yaw) > 0.35 || Math.abs(look.pitch) > 0.35;
        const stopTower = stop && !lookedAway ? towerByName.get(stop.name) : undefined;
        if (stopTower) ctx.cellTop(stopTower.name, stopTower.top);
        fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        ahead = stopTower ? nearestTowerAhead([stopTower], ctx.camera.position, fwd, ctx.lattice.radius, ahead) : null;
      } else ahead = null;
      const { name, byKeyboard, byWalk } = pick.update({ strict: walking, forced: ahead });
      if (name && ctx.cellTop(name, tmp)) {
        ctx.hilite(name, byWalk ? (name === dwelling ? 1 : 0.6) : 1);
        if (byKeyboard && !walking) { // a keyboard-focused cell may be off screen: ease the camera toward it (never on the walk: there the camera is the walker's, and focus only shows the card and highlight). A hovered one never moves the camera.
          view.focus.copy(tmp);
          view.focusWeight = motion.camera.hoverBias;
        }
      }
    },
    exit() {
      ctx.comet.clear();
      pick.disable();
      look.disable();
      view.lookYaw = view.lookPitch = 0;
      captions.forEach((c) => setOpacity(c.el, 0));
      chipLists.forEach((l) => setOpacity(l.el, 0));
      scene.fade(0);
    },
    dispose() {
      pick.dispose();
      look.disable();
    },
  };
}
