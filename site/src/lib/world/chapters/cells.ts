// Chapter 2. The camera flies along the lattice (camera-path.ts). Hovering a cell, or focusing its entry in the
// hidden agent list, lifts and brightens it and shows its label card (pick.ts). No roster panels: the roster lives in
// the Reference section. The tier legend chip of the active agent's band lights (opacity only).
import { Vector3 } from 'three';
import { nearestTowerAhead, type TowerRef, type WalkRoute } from '../walk';
import { createWalkLook } from '../walk-look';
import { motion, recedeMix, walkCfg, walkRamp, walkUOf } from '../motion-config';
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
  // the tour timeline: dive, one segment per band, rise, on the axis walkRamp.inFrom..outTo of the Cells progress (autoplay is linear in it, so width = time). Sized from the route when it exists.
  const track: HTMLElement | undefined = scene.q('[data-tour]')[0];
  const head = track?.querySelector<HTMLElement>('.tour-head') ?? null;
  const segs = new Map([...(track?.querySelectorAll<HTMLElement>('[data-seg]') ?? [])].map((el) => [el.dataset.seg!, el]));
  const A0 = walkRamp.inFrom, A1 = walkRamp.outTo;
  const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
  const pOfU = (u: number) => walkCfg.uFrom + u * (walkCfg.uTo - walkCfg.uFrom);
  const tOfP = (p: number) => clamp01((p - A0) / (A1 - A0));
  const pOfT = (t: number) => A0 + t * (A1 - A0);
  let tourRoute: WalkRoute | null = null, tourW = 0, tourLast = -1, tourText = '', lastP = 0;
  const phaseOf = (p: number, u: number) => (p < walkCfg.uFrom ? (p < A0 ? 'Orbit' : 'The dive') : p > walkCfg.uTo ? 'The rise' : (bandRange && [...bandRange].find(([, r]) => u >= r[0] && u <= r[1])?.[0]) || 'The walk');
  const buildTour = (route: WalkRoute) => {
    tourRoute = route;
    const ranges = bandRange ?? rangesOf(route);
    const set = (el: HTMLElement | undefined, a: number, b: number) => { if (el) el.style.flexGrow = String(Math.max(0, b - a)); };
    set(segs.get('dive'), A0, walkCfg.uFrom);
    set(segs.get('rise'), walkCfg.uTo, A1);
    segs.forEach((el, band) => { if (band !== 'dive' && band !== 'rise' && !ranges.has(band)) el.style.display = 'none'; }); // a band with no stop on the route has no segment
    ranges.forEach((r, band) => { const el = segs.get(band); set(el, pOfU(r[0]), pOfU(band === [...ranges.keys()].at(-1) ? 1 : r[1])); });
    route.stops.forEach((s) => { // one tick per tower, in the band's segment
      const el = segs.get(s.band);
      const r = ranges.get(s.band);
      if (!el || !r) return;
      const tick = document.createElement('i');
      tick.style.left = `${((((s.u0 + s.u1) / 2 - r[0]) / (r[1] - r[0])) * 100).toFixed(2)}%`;
      tick.title = s.name;
      el.append(tick);
    });
    tourW = track?.clientWidth ?? 0;
  };
  const seekTo = (e: PointerEvent) => { if (track) ctx.scroll.seek(pOfT(clamp01((e.clientX - track.getBoundingClientRect().left) / track.clientWidth))); };
  let dragging = false;
  const onDown = (e: PointerEvent) => { dragging = true; track!.setPointerCapture(e.pointerId); seekTo(e); };
  const onMove = (e: PointerEvent) => { if (dragging) seekTo(e); };
  const onUp = () => { dragging = false; };
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -0.02 : e.key === 'ArrowRight' ? 0.02 : e.key === 'PageUp' ? -0.1 : e.key === 'PageDown' ? 0.1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : step ? tOfP(lastP) + step : null;
    if (to === null) return;
    e.preventDefault(); e.stopPropagation(); // (the page-level keys would switch autoplay off)
    ctx.scroll.seek(pOfT(clamp01(to)));
  };
  const onResize = () => { tourW = track?.clientWidth ?? 0; };
  const look = createWalkLook(); // drag to look around while walking
  const bandOf = new Map(ctx.agents.map((a) => [a.name, a.band as string]));
  const legend = new Map(scene.q('[data-legend]').map((e) => [e.dataset.legend!, e.querySelector<HTMLElement>('.chip-ring')!]));

  return {
    enter() {
      pick.enable();
      look.enable();
      if (track) {
        track.addEventListener('pointerdown', onDown); track.addEventListener('pointermove', onMove); track.addEventListener('pointerup', onUp); track.addEventListener('pointercancel', onUp);
        track.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
      }
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
      lastP = p;
      if (route && tourRoute !== route) buildTour(route);
      if (head && track) { // playhead: transform only, quantized to a pixel
        const x = Math.round(tOfP(p) * tourW);
        if (x !== tourLast) {
          tourLast = x;
          head.style.transform = `translateX(${x}px)`;
          track.setAttribute('aria-valuenow', String(Math.round(tOfP(p) * 100)));
        }
        const text = phaseOf(p, u);
        if (text !== tourText) { tourText = text; track.setAttribute('aria-valuetext', text); }
      }
      const stop = route?.stops[view.walkStop];
      const dwelling = stop && u >= stop.u0 && u <= stop.u1 ? stop.name : null; // holding at this tower
      if (view.walk > 0.85) { // cards only once the camera is on the ground (not mid-dive)
        towers.forEach((t) => ctx.cellTop(t.name, t.top));
        fwd.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion);
        // the tour: the tower the route is heading for (or holding at) owns the card, unless you have turned your head away from it; otherwise the nearest one ahead
        const lookedAway = Math.abs(look.yaw) > 0.35 || Math.abs(look.pitch) > 0.35;
        const stopTower = stop && !lookedAway ? towerByName.get(stop.name) : undefined;
        ahead = (stopTower ? nearestTowerAhead([stopTower], ctx.camera.position, fwd, ctx.lattice.radius, ahead) : null)
          ?? nearestTowerAhead(towers, ctx.camera.position, fwd, ctx.lattice.radius, ahead);
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
      pick.disable();
      if (track) {
        track.removeEventListener('pointerdown', onDown); track.removeEventListener('pointermove', onMove); track.removeEventListener('pointerup', onUp); track.removeEventListener('pointercancel', onUp);
        track.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
      }
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
