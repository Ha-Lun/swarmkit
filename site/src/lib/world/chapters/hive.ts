// Chapter 1. A task packet enters, is "classified" at the core cell, travels to a specialist cell, then fans out
// to the three gate cells at once. Every stop is looked up by agent name from routing.ts; no coordinates here.
//
// The packet is scrubbed by scroll across the pinned window (the world only reads chapterProgress). The four
// captions are pre-rendered and stacked; this chapter only writes their opacity, so nothing is inserted or
// removed mid-scroll. The three example buttons replay their route on the same packet, in real time.
import { Vector3 } from 'three';
import { motion } from '../motion-config';
import { entryPoint, headAt, makeTimeline, stopProgress, withArcs, type Timeline } from '../routes';
import { pinWindow, presence, range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Replay { t0: number; tl: Timeline; stops: string[]; slug: string; tier: string }

export function createHive(ctx: WorldCtx): Chapter {
  const { gates: gateNames, specialist, mainTier } = ctx.routing; // names from routing.ts, resolved at build time (that module reads the repo with node fs)
  const core = ctx.lattice.cells.find((c) => c.agent?.band === 'core')?.agent?.name;
  const scene = sceneOf('hive');
  const win = pinWindow(motion.runway.hive);

  const steps = scene.q('[data-caption]'); // 0 task in, 1 classified, 2 routed, 3 gates in parallel
  const exampleCaps = scene.q('[data-caption-example]');
  const chipRings = new Map(scene.q('[data-chip]').map((e) => [e.dataset.chip!, e.querySelector<HTMLElement>('.chip-ring')!]));

  let main: Timeline | null = null;
  let mainPts: Vector3[] = [];
  let mainCore = 0, coreLeave = 0;
  let fanTotal = 0;
  let total = 1;
  let ready = false;
  let replay: Replay | null = null;

  function build() {
    const a = new Vector3(), b = new Vector3();
    if (!core || !specialist || !ctx.cellTop(core, a) || !ctx.cellTop(specialist, b)) return; // roster changed: draw nothing rather than guess
    mainPts = withArcs([entryPoint(ctx.lattice), a, b]);
    const len = ctx.flows[0].setRoute(mainPts);
    const [sCore, sSpec] = stopProgress(ctx.flows[0].curve, [a, b]);
    main = makeTimeline(len, [sCore, sSpec], motion.packet.unitsPerSec, [motion.packet.coreDwellSec, 0.25]);
    mainCore = main.arrivals[0];
    coreLeave = mainCore + motion.packet.coreDwellSec;
    // fan-out legs all last as long as the longest one, so the three packets arrive together
    const legs = gateNames.map((n, i) => {
      const g = new Vector3();
      if (!ctx.cellTop(n, g)) return 0;
      return ctx.flows[i + 1].setRoute(withArcs([b, g]));
    });
    fanTotal = Math.max(...legs) / motion.packet.unitsPerSec;
    total = main.total + fanTotal + motion.hive.holdSec;
    ready = fanTotal > 0;
  }

  const pulse = (t: number, at: number, dur: number) => clamp01((t - at) / 0.2) * (1 - clamp01((t - at - 0.2) / dur));

  function startReplay(btn: HTMLElement) {
    const names = (btn.dataset.route ?? '').split(',').filter(Boolean);
    const stops = [core, ...names].filter((n): n is string => !!n && ctx.cellIndex(n) >= 0);
    const pts = stops.map((n) => ctx.cellTop(n, new Vector3())!);
    if (!pts.length) return;
    const flow = ctx.flows[0];
    const len = flow.setRoute(withArcs([entryPoint(ctx.lattice), ...pts]));
    const s = stopProgress(flow.curve, pts);
    // a route with no agent step (a direct edit) still visits the core and stops there
    replay = { t0: ctx.time, tl: makeTimeline(len, s, motion.packet.unitsPerSec, s.map(() => motion.packet.dwellSec)), stops, slug: btn.dataset.replay!, tier: btn.dataset.tier ?? '' };
  }
  function endReplay() {
    if (!replay) return;
    replay = null;
    ctx.flows[0].hide();
    if (ready) ctx.flows[0].setRoute(mainPts); // the scrubbed route is back on the packet
  }

  const onClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-replay]') : null;
    if (btn) startReplay(btn); // pressing the same one again restarts it
  };

  return {
    enter() {
      if (!ready) build();
      document.addEventListener('click', onClick);
    },
    update(p) {
      scene.fade(presence(p, win));
      if (!ready || !main) return;
      const g = clamp01((p - win[0]) / (win[1] - win[0]));
      const cam = ctx.camera;
      const leave = 1 - range(p, win[1], 1); // the packet dims as the scene scrolls away
      const t = g * total;

      // ---- replay (real time) or scrub (scroll) ----
      let rw = 0; // replay weight
      if (replay) {
        const rt = ctx.time - replay.t0;
        const flow = ctx.flows[0];
        const fadeIn = clamp01(rt / motion.packet.fadeSec);
        const fadeOut = 1 - smooth(clamp01((rt - replay.tl.total) / motion.packet.fadeSec));
        const r = replay.tl.rAt(rt);
        flow.set(r, cam, Math.min(fadeIn, fadeOut) * leave);
        ctx.flows[1].hide(); ctx.flows[2].hide(); ctx.flows[3].hide();
        replay.tl.arrivals.forEach((at, i) => {
          const env = clamp01((rt - at) / 0.2) * (1 - clamp01((rt - at - 0.2) / motion.packet.dwellSec));
          if (replay!.stops[i]) ctx.glow(replay!.stops[i], env);
        });
        ctx.view.focus.copy(headAt(flow, r, new Vector3()));
        ctx.view.focusWeight = motion.camera.routeBias;
        ctx.view.focusDrop = motion.camera.routeDrop;
        ctx.view.overview = motion.camera.routeOverview;
        rw = Math.min(clamp01(rt / 0.4), fadeOut);
        if (fadeOut <= 0) endReplay();
      } else {
        const fanStart = main.total;
        const holdStart = fanStart + fanTotal;
        if (t < fanStart) {
          ctx.flows[0].set(main.rAt(t), cam, clamp01(t / motion.packet.fadeSec) * leave);
          ctx.flows[1].hide(); ctx.flows[2].hide(); ctx.flows[3].hide();
        } else {
          ctx.flows[0].hide();
          const r = smooth(clamp01((t - fanStart) / fanTotal));
          for (let i = 0; i < 3; i++) ctx.flows[i + 1].set(r, cam, leave);
        }
        if (core) ctx.glow(core, pulse(t, mainCore, motion.packet.coreDwellSec));
        if (specialist) ctx.glow(specialist, pulse(t, main.arrivals[1], 0.6));
        gateNames.forEach((n) => ctx.glow(n, pulse(t, holdStart, 0.9) * leave));
      }

      // ---- captions and chips: opacity only ----
      const bl = motion.hive.captionBlend;
      const at = (s: number) => range(g, s / total - bl, s / total + bl);
      const b1 = at(mainCore), b2 = at(coreLeave), b3 = at(main.total);
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
      document.removeEventListener('click', onClick);
      scene.fade(0);
    },
    dispose() {
      document.removeEventListener('click', onClick);
    },
  };
}
