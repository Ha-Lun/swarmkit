// Chapter 1. A comet enters, is "classified" at the core panel (it holds while a thin scanning ring is engraved onto the
// panel), travels to a specialist panel, then fans out to the three gate panels at once. Every stop is looked up by agent name
// from routing.ts; no coordinates here.
//
// Motion: the comet follows great-circle legs at a low constant lift. Every leg eases in and out (it accelerates out of a stop
// and decelerates into the next); the fan-out legs last exactly as long as the longest one, so the three leave together and
// land together. On landing, a short ripple ring runs across the surface and the panel lifts a little.
//
// The comet is scrubbed by scroll across the pinned window (the world only reads chapterProgress). The four captions are
// pre-rendered and stacked; this chapter only writes their opacity, so nothing is inserted or removed mid-scroll. The three
// example buttons replay their route on the same comet, in real time, with the same choreography.
import { Vector3 } from 'three';
import { motion } from '../motion-config';
import { entryPoint, raise, Route, Timeline } from '../routes';
import { pinWindow, range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Replay { t0: number; route: Route; tl: Timeline; stops: string[]; slug: string; tier: string }

export function createHive(ctx: WorldCtx): Chapter {
  const { gates: gateNames, specialist, mainTier } = ctx.routing; // names from routing.ts, resolved at build time (that module reads the repo with node fs)
  const core = ctx.lattice.cells.find((c) => c.agent?.band === 'core')?.agent?.name;
  const scene = sceneOf('hive');
  const win = pinWindow(motion.runway.hive);
  const P = motion.packet;

  const steps = scene.q('[data-caption]'); // 0 task in, 1 classified, 2 routed, 3 gates in parallel
  const exampleCaps = scene.q('[data-caption-example]');
  const chipRings = new Map(scene.q('[data-chip]').map((e) => [e.dataset.chip!, e.querySelector<HTMLElement>('.chip-ring')!]));

  let main: Timeline | null = null;
  let mainRoute: Route | null = null;
  let fan: { route: Route; tl: Timeline }[] = [];
  let fanStart = 0, fanEnd = 0, total = 1;
  let ready = false;
  let replay: Replay | null = null;

  const cell = (name: string) => ctx.lattice.cells[ctx.cellIndex(name)];
  const top = (name: string) => (ctx.cellTop(name, new Vector3()) ? raise(ctx.cellTop(name, new Vector3())!) : null);

  function build() {
    const a = core ? top(core) : null, b = specialist ? top(specialist) : null;
    if (!core || !specialist || !a || !b) return; // roster changed: draw nothing rather than guess
    mainRoute = new Route([entryPoint(ctx.lattice), a, b]);
    main = new Timeline(mainRoute, P.meanSpeed, [P.coreHoldSec, P.specHoldSec], P.minLegSec);
    const legs = gateNames.map((n) => { const g = top(n); return g ? new Route([b, g]) : null; });
    if (legs.some((l) => !l)) return;
    // the fan-out legs all last as long as the longest one, so the three comets leave together and land together
    const fanSec = Math.max(P.minLegSec, ...legs.map((l) => l!.length / P.meanSpeed));
    fan = legs.map((route) => ({ route: route!, tl: new Timeline(route!, P.meanSpeed, [], P.minLegSec, fanSec) }));
    fan.forEach((f, i) => ctx.flows[i + 1].setRoute(f.route));
    ctx.flows[0].setRoute(mainRoute);
    fanStart = main.leaves[1];
    fanEnd = fanStart + fanSec;
    total = fanEnd + P.hiveHoldSec;
    ready = true;
  }

  const pulse = (t: number, at: number, dur: number) => clamp01((t - at) / 0.2) * (1 - clamp01((t - at - 0.2) / dur));

  /** the scanning ring at the core and the arrival ripples, as pure functions of time (so scrubbing back and forth is exact) */
  function drawRings(t: number, scanAt: number, scanLeave: number, ripples: { name: string; at: number }[]) {
    const R = ctx.rings;
    R.clearAll();
    if (core) {
      const c = cell(core);
      const grow = clamp01((t - scanAt) / (scanLeave - scanAt));
      const fadeOut = 1 - clamp01((t - scanLeave) / P.scan.fade);
      if (t > scanAt && fadeOut > 0) R.set(0, c.normal, c.half * P.scan.radius, P.scan.width * fadeOut, Math.max(0.02, smooth(grow)));
    }
    ripples.forEach((rp, i) => {
      const u = (t - rp.at) / P.ripple.sec;
      if (u <= 0 || u >= 1 || i + 1 >= 8) return;
      const c = cell(rp.name);
      // the ripple keeps its width and is wiped away by its arc shrinking (a hard-edged fade, no dotted thin line)
      R.set(i + 1, c.normal, c.half * 0.55 + (t - rp.at) * P.ripple.speed, P.ripple.width, 1 - smooth(clamp01((u - 0.5) / 0.5)));
    });
  }

  function startReplay(btn: HTMLElement) {
    const names = (btn.dataset.route ?? '').split(',').filter(Boolean);
    const stops = [core, ...names].filter((n): n is string => !!n && ctx.cellIndex(n) >= 0);
    const pts = stops.map((n) => top(n)!);
    if (!pts.length) return;
    // a route with no agent step (a direct edit) still visits the core and stops there
    const route = new Route([entryPoint(ctx.lattice), ...pts]);
    const tl = new Timeline(route, P.meanSpeed, stops.map((_, i) => (i === 0 ? P.coreHoldSec : P.holdSec)), P.minLegSec);
    ctx.flows[0].setRoute(route);
    replay = { t0: ctx.time, route, tl, stops, slug: btn.dataset.replay!, tier: btn.dataset.tier ?? '' };
  }
  function endReplay() {
    if (!replay) return;
    replay = null;
    ctx.rings.clearAll();
    ctx.flows[0].hide();
    if (ready && mainRoute) ctx.flows[0].setRoute(mainRoute); // the scrubbed route is back on the comet
  }

  const onClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-replay]') : null;
    if (btn) startReplay(btn); // pressing the same one again restarts it
  };

  const head = new Vector3();
  return {
    enter() {
      if (!ready) build();
      document.addEventListener('click', onClick);
    },
    fade: (v) => scene.fade(v),
    update(p) {
      if (!ready || !main || !mainRoute) return;
      const g = clamp01((p - win[0]) / (win[1] - win[0]));
      const cam = ctx.camera;
      const dt = ctx.dt;
      const leave = 1 - range(p, win[1], 1); // the comet shrinks away as the scene fades out
      const t = g * total;

      // ---- replay (real time) or scrub (scroll) ----
      let rw = 0; // replay weight
      if (replay) {
        const rt = ctx.time - replay.t0;
        const flow = ctx.flows[0];
        const fadeIn = clamp01(rt / P.fadeSec);
        const fadeOut = 1 - smooth(clamp01((rt - replay.tl.total) / P.fadeSec));
        const d = replay.tl.distAt(rt);
        flow.set(d, cam, Math.min(fadeIn, fadeOut) * leave, dt);
        ctx.flows[1].hide(); ctx.flows[2].hide(); ctx.flows[3].hide();
        replay.tl.arrivals.forEach((at, i) => { // arrivals[0] is the core, the rest follow the stops
          if (replay!.stops[i]) ctx.hilite(replay!.stops[i], pulse(rt, at, P.holdSec) * motion.hilite.strike);
        });
        drawRings(rt, replay.tl.arrivals[0], replay.tl.leaves[0], replay.stops.slice(1).map((name, i) => ({ name, at: replay!.tl.arrivals[i + 1] })));
        flow.headAt(d, head);
        ctx.view.focus.copy(head);
        ctx.view.focusWeight = motion.camera.routeBias;
        ctx.view.focusDrop = motion.camera.routeDrop;
        ctx.view.overview = motion.camera.routeOverview;
        rw = Math.min(clamp01(rt / 0.4), fadeOut);
        if (fadeOut <= 0) endReplay();
      } else {
        if (t < fanStart) {
          ctx.flows[0].set(main.distAt(t), cam, clamp01(t / P.fadeSec) * leave, dt);
          ctx.flows[1].hide(); ctx.flows[2].hide(); ctx.flows[3].hide();
          ctx.flows[0].headAt(main.distAt(t), head);
        } else {
          ctx.flows[0].hide();
          fan.forEach((f, i) => ctx.flows[i + 1].set(f.tl.distAt(t - fanStart), cam, leave, dt));
          const mid = fan[0].tl.distAt(t - fanStart);
          ctx.flows[1].headAt(mid, head);
        }
        drawRings(t, main.arrivals[0], main.leaves[0], [{ name: specialist!, at: main.arrivals[1] }, ...gateNames.map((name) => ({ name, at: fanEnd }))]);
        // the look-at leans gently toward the comet head while it is on screen
        ctx.view.focus.copy(head);
        ctx.view.focusWeight = motion.camera.hiveBias * clamp01(t / P.fadeSec) * leave;
        if (core) ctx.hilite(core, pulse(t, main.arrivals[0], P.coreHoldSec) * motion.hilite.strike);
        if (specialist) ctx.hilite(specialist, pulse(t, main.arrivals[1], P.specHoldSec) * motion.hilite.strike);
        gateNames.forEach((n) => ctx.hilite(n, pulse(t, fanEnd, 0.5) * leave * motion.hilite.strike));
      }

      // ---- captions and chips: opacity only ----
      const bl = motion.hive.captionBlend;
      const at = (s: number) => range(g, s / total - bl, s / total + bl);
      const b1 = at(main.arrivals[0]), b2 = at(main.leaves[0]), b3 = at(fanStart);
      const w = [1 - b1, b1 - b2, b2 - b3, b3];
      steps.forEach((el, i) => setOpacity(el, (w[i] ?? 0) * (1 - rw)));
      exampleCaps.forEach((el) => setOpacity(el, el.dataset.captionExample === replay?.slug ? rw : 0));
      chipRings.forEach((ring, tier) => {
        const scrub = tier === mainTier ? (1 - w[0]) * (1 - rw) : 0;
        setOpacity(ring, Math.max(scrub, replay?.tier === tier ? rw : 0));
      });
    },
    exit() {
      endReplay();
      ctx.flows.forEach((f) => f.hide());
      ctx.rings.clearAll();
      document.removeEventListener('click', onClick);
      scene.fade(0);
    },
    dispose() {
      document.removeEventListener('click', onClick);
    },
  };
}
