// Chapter 1. A task packet enters, is "classified" at the core cell, travels to a specialist cell, then fans out
// to the three gate cells at once. Every stop is looked up by agent name from routing.ts; no coordinates here.
import { Vector3 } from 'three';
import { motion } from '../motion-config';
import { entryPoint, makeTimeline, stopProgress, withArcs, type Timeline } from '../routes';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

export function createHive(ctx: WorldCtx): Chapter {
  const { gates: gateNames, specialist } = ctx.routing; // names from routing.ts, resolved at build time (that module reads the repo with node fs)
  const core = ctx.lattice.cells.find((c) => c.agent?.band === 'core')?.agent?.name;

  let t0 = 0;
  let main: Timeline | null = null;
  let mainCore = 0; // arrival times
  let mainSpec = 0;
  let fanTotal = 0;
  let cycle = 0;
  let ready = false;

  function build() {
    const a = new Vector3(), b = new Vector3();
    if (!core || !specialist || !ctx.cellTop(core, a) || !ctx.cellTop(specialist, b)) return; // roster changed: draw nothing rather than guess
    const entry = entryPoint(ctx.lattice);
    const len = ctx.flows[0].setRoute(withArcs([entry, a, b]));
    const [sCore, sSpec] = stopProgress(ctx.flows[0].curve, [a, b]);
    main = makeTimeline(len, [sCore, sSpec], motion.packet.unitsPerSec, [motion.packet.coreDwellSec, 0.25]);
    [mainCore, mainSpec] = main.arrivals;
    // fan-out legs all last as long as the longest one, so the three packets arrive together
    const legs = gateNames.map((n, i) => {
      const g = new Vector3();
      if (!ctx.cellTop(n, g)) return 0;
      return ctx.flows[i + 1].setRoute(withArcs([b, g]));
    });
    fanTotal = Math.max(...legs) / motion.packet.unitsPerSec;
    cycle = main.total + fanTotal + motion.packet.hiveHoldSec + motion.packet.hiveGapSec;
    ready = fanTotal > 0;
  }

  const pulse = (t: number, at: number, dur: number) => clamp01((t - at) / 0.2) * (1 - clamp01((t - at - 0.2) / dur));

  return {
    enter() {
      t0 = ctx.time;
      if (!ready) build();
    },
    update() {
      if (!ready || !main) return;
      const t = (ctx.time - t0) % cycle;
      const cam = ctx.camera;
      const fadeIn = clamp01(t / motion.packet.fadeSec);
      const fanStart = main.total;
      const holdStart = fanStart + fanTotal;
      const fadeOut = 1 - smooth(clamp01((t - holdStart - motion.packet.hiveHoldSec + motion.packet.fadeSec) / motion.packet.fadeSec));

      if (t < fanStart) {
        ctx.flows[0].set(main.rAt(t), cam, fadeIn);
        ctx.flows[1].hide(); ctx.flows[2].hide(); ctx.flows[3].hide();
      } else {
        ctx.flows[0].hide();
        const r = smooth(clamp01((t - fanStart) / fanTotal));
        for (let i = 0; i < 3; i++) ctx.flows[i + 1].set(r, cam, fadeOut);
      }

      if (core) ctx.glow(core, pulse(t, mainCore, motion.packet.coreDwellSec));
      if (specialist) ctx.glow(specialist, pulse(t, mainSpec, 0.6));
      gateNames.forEach((n) => ctx.glow(n, pulse(t, holdStart, 0.9) * fadeOut));
    },
    exit() {
      ctx.flows.forEach((f) => f.hide());
    },
  };
}
