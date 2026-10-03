// Chapter 2. The camera flies along the lattice (camera-path.ts). Hovering a cell, or focusing its entry in the
// hidden agent list, lifts and brightens it and shows its label card (pick.ts). No roster panels: the roster lives in
// the Reference section. The tier legend chip of the active agent's band lights (opacity only).
import { Vector3 } from 'three';
import { nearestTowerAhead, type TowerRef, type WalkRoute } from '../walk';
import { createWalkLook } from '../walk-look';
import { createJourneyComet } from '../journey-comet';
import { aerial, motion, recedeMix, walkCfg, walkUOf } from '../motion-config';
import { createPick } from '../pick';
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createCells(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const scene = sceneOf('cells');
  const pick = createPick(ctx, scene.root);
  const tmp = new Vector3();
  // the walk: the tower the walker is heading for shows its card (pointer hover and keyboard focus still win)
  const towers: TowerRef[] = ctx.lattice.cells.filter((c) => c.agent && !c.moon).map((c) => ({ name: c.agent!.name, top: new Vector3() }));
  const towerByName = new Map(towers.map((t) => [t.name, t]));
  const fwd = new Vector3();
  let ahead: string | null = null;
  // the band chips fill as the walk passes through their towers: a band runs from the end of the previous band's last stop to the end of its own (route data, nothing hardcoded)
  const fills = scene.q('[data-fill]').map((el) => ({ el, band: el.dataset.fill!, last: -1 }));
  let bandRange: Map<string, [number, number]> | null = null, bandRoute: WalkRoute | null = null;
  const rangesOf = (route: WalkRoute) => {
    const m = new Map<string, [number, number]>();
    let start = 0;
    route.stops.forEach((s, i) => {
      if (i === route.stops.length - 1 || route.stops[i + 1].band !== s.band) { m.set(s.band, [start, s.u1]); start = s.u1; }
    });
    return m;
  };
  const look = createWalkLook(); // drag to look around while walking
  const comet = createJourneyComet(ctx, ctx.flows[4], ctx.flows.slice(5, 8)); // the task's comet: it lands on each tower the journey visits
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
      const route = ctx.walkRoute;
      const u = walkUOf(p);
      if (route) {
        if (bandRoute !== route) { bandRange = rangesOf(route); bandRoute = route; } // (rebuilt if the world ever builds a new route)
        for (const f of fills) {
          const r = bandRange!.get(f.band);
          const v = r ? Math.round(Math.min(1, Math.max(0, (u - r[0]) / (r[1] - r[0]))) * 500) / 500 : 0;
          if (v !== f.last) { f.last = v; f.el.style.transform = `scaleX(${v})`; }
        }
      }
      // the aerial: the camera rises to the whole-globe view for the gates and returns for the Proof pull-back
      view.overview = range(p, aerial.overviewIn[0], aerial.overviewIn[1]) * (1 - range(p, aerial.overviewOut[0], aerial.overviewOut[1]));
      comet.update(route, (view.walkCp - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom), view.walk, view.walkCp); // (unclamped: the comet comes down with the dive and stays until the rise)
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
      const band = name ? bandOf.get(name) : null;
      legend.forEach((ring, b) => setOpacity(ring, b === band ? 1 : 0));
    },
    exit() {
      comet.clear();
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
