// Chapter 2. The task's journey: the camera follows the comet in and from tower to tower (follow.ts), and the steps are called out while the comet is at them: the current step's caption shows and
// its chip lights and fills (all pre-rendered from the routing data, only opacity and a scale are written). Hovering a cell, or focusing its entry in the hidden agent list, lifts and
// brightens it and shows its label card (pick.ts). No roster panels: the roster lives in the Reference section.
import { Vector3 } from 'three';
import { nearestTowerAhead, type TowerRef } from '../walk';
import { createWalkLook } from '../walk-look';
import { aerial, motion, recedeMix, walkCfg } from '../motion-config';
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
  const doneCaptions = scene.q('[data-caption-done]').map((el) => ({ el, j: Number(el.dataset.j) })); // the closing line, once the gates have passed
  const gateTags = scene.q('[data-gate-tag]').map((el) => ({ el, j: Number(el.dataset.j), name: el.dataset.gateTag!, x: NaN, y: NaN })); // the gates' name tags, over their towers while their comets land
  const taskTags = scene.q('[data-task-tag]').map((el) => ({ el, j: Number(el.dataset.j) })); // the task's name, on screen for the whole walk
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
      const uNow = (view.walkCp - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom); // the route parameter of the camera (the damped progress), unclamped: negative before the launch
      // the steps: where each step's window is in the journey (a stop's hold is shared by the steps shown at it; the gates run together once the camera has risen)
      const jr = routing.journeys[view.journey];
      const stops = route?.stops;
      const windowOf = (bi: number): [number, number] => { // [start, end] in route parameter, or in Cells progress for a gate
        const b = jr.beats[bi];
        if (b.stop < 0) return [aerial.captionFrom, aerial.doneFrom];
        const s = stops![b.stop], slot = (s.u1 - s.u0) / b.of, w0 = s.u0 + slot * b.k;
        return [bi === 0 ? -1 : w0, w0 + slot];
      };
      const posOf = (bi: number) => (jr.beats[bi].stop < 0 ? p : uNow);
      const weightOf = (bi: number) => { const [a, b] = windowOf(bi); return win(posOf(bi), a, b); };
      if (stops && jr) {
        const gateBeat = jr.beats.findIndex((b) => b.stop < 0);
        captions.forEach((c) => setOpacity(c.el, c.j !== view.journey ? 0 : weightOf(c.b >= 0 ? c.b : gateBeat)));
        const doneFrom = jr.gates.length ? aerial.doneFrom : walkCfg.uTo + EPS; // (a task with no gate has nothing to say between its last step and the end)
        doneCaptions.forEach((c) => setOpacity(c.el, c.j !== view.journey ? 0 : range(p, doneFrom - EPS, doneFrom + EPS)));
        taskTags.forEach((t) => setOpacity(t.el, t.j === view.journey ? 1 : 0));
        const tagIn = range(p, aerial.fanFrom - EPS, aerial.fanFrom + EPS) * (1 - range(p, aerial.doneFrom - EPS, aerial.doneFrom)); // (from the moment the comets leave, until the closing line)
        gateTags.forEach((t) => {
          const on = t.j === view.journey ? tagIn : 0;
          setOpacity(t.el, on);
          if (on <= 0.01 || !ctx.cellTop(t.name, tmp)) return;
          tmp.project(ctx.camera);
          const x = Math.round(((tmp.x + 1) / 2) * window.innerWidth * 2) / 2, y = Math.round(((1 - tmp.y) / 2) * window.innerHeight * 2) / 2;
          if (x !== t.x || y !== t.y) { t.x = x; t.y = y; t.el.style.transform = y < 150 ? `translate3d(${x}px, ${y + 40}px, 0) translate(-50%, 0)` : `translate3d(${x}px, ${y - 48}px, 0) translate(-50%, -100%)`; } // (over the tower, or under it when there is no room below the nav)
        });
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
      ctx.comet.update(route, uNow, view.walk, view.walkCp);
      const stop = route?.stops[view.walkStop];
      const dwelling = stop && uNow >= stop.u0 && uNow <= stop.u1 ? stop.name : null; // holding at this tower
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
      doneCaptions.forEach((c) => setOpacity(c.el, 0));
      taskTags.forEach((t) => setOpacity(t.el, 0));
      gateTags.forEach((t) => setOpacity(t.el, 0));
      chipLists.forEach((l) => setOpacity(l.el, 0));
      scene.fade(0);
    },
    dispose() {
      pick.dispose();
      look.disable();
    },
  };
}
