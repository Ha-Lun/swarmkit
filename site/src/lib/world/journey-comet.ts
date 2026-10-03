// The task's comet, drawn on the follow route's own path (follow.ts: a pure function of the route parameter u, so scrubbing, autoplay and the wheel stay exact, both ways). It waits on the
// entry point (the Hive shows it waiting there), flies in to the core cap and then from cap to cap, resting on each for the hold. Rings and the arrival lift are drawn from the same u; after the last stop the gates this task
// triggers receive their comets in parallel (timed in the Cells progress, once the camera has risen).
import { aerial, motion, walkCfg } from './motion-config';
import { clearRadius, easeLeg, raise, Route, type Flow } from './routes';
import { RING_SLOTS } from './rings';
import type { WalkRoute } from './walk';
import type { WorldCtx } from './types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const RIPPLE_P = 0.02; // the gates' landing ripple and lift, in Cells progress (about 1.5 s at the tail's autoplay pace)

export interface JourneyComet {
  /** draw the comet, its rings and its arrival lift for route parameter `u` (unclamped: negative during the dive, above 1 during the rise); `walk` = the walk weight, `cp` = the Cells
   *  progress (the gates' fan-out is timed in it: the walker has stopped by then, so there is no route parameter left) */
  update(route: WalkRoute | null, u: number, walk: number, cp: number): void;
  /** hide everything (leaving the chapter) */
  clear(): void;
}

export function createJourneyComet(ctx: WorldCtx, flow: Flow, gateFlows: Flow[]): JourneyComet {
  const P = motion.packet;
  let builtFor: WalkRoute | null = null;
  let names: string[] = [];
  let land: number[] = []; // per stop: u at which the comet lands on it
  let endU = 1;
  let gateNames: string[] = [], gateRoutes: Route[] = [];

  const capTop = (name: string) => { const c = ctx.lattice.cells[ctx.cellIndex(name)]; return raise(c.pos.clone().addScaledVector(c.normal, c.base)); };

  function build(wr: WalkRoute) {
    builtFor = wr;
    names = wr.stops.map((s) => s.name);
    land = wr.stops.map((s) => s.u0);
    endU = wr.stops[wr.stops.length - 1].u1;
    flow.setRoute(wr.cometRoute);
    // the gates this task triggers (journeys.ts): one comet each, from the last stop, leaving together and landing together
    gateNames = ctx.routing.journeys[ctx.view.journey]?.gates.filter((g) => ctx.cellIndex(g) >= 0).slice(0, gateFlows.length) ?? [];
    const from = capTop(names[names.length - 1]);
    gateRoutes = gateNames.map((g) => new Route([from, capTop(g)], clearRadius(ctx.lattice)));
    gateRoutes.forEach((r, i) => gateFlows[i].setRoute(r));
    gateFlows.slice(gateNames.length).forEach((f) => f.hide());
  }

  const pulse = (u: number, at: number, dur: number) => clamp01((u - at) / RIPPLE_P) * (1 - clamp01((u - at - RIPPLE_P) / dur)); // (a quick rise, then a fade over `dur`)
  /** a ripple ring on the cap of tower `name`, `k` (0..1) of the way through its life; the ring shell is one radius for every ring: the last one set wins, which is the tower being arrived at */
  const ripple = (slot: number, name: string, k: number) => {
    const c = ctx.lattice.cells[ctx.cellIndex(name)];
    if (c.moon) ctx.rings.setShell(c.bodyRadius + c.height + 0.045, ctx.lattice.moon.pos); // (a tower on the moon: the shell about the moon's centre)
    else ctx.rings.setShell(ctx.lattice.radius + c.height + 0.045);
    ctx.rings.set(slot, c.normal, c.half * (0.3 + 0.62 * k), P.ripple.width * (c.moon ? 0.7 : 1), 1 - smooth(clamp01((k - 0.5) / 0.5)));
  };

  return {
    update(wr, u, walk, cp) {
      if (!wr || wr.stops.length === 0) { this.clear(); return; }
      if (builtFor !== wr) build(wr);
      const L = wr.length;
      const sec = (s: number) => (s * walkCfg.rate) / L; // seconds -> route parameter
      const fan = clamp01((cp - aerial.fanFrom) / (aerial.fanTo - aerial.fanFrom)); // 0 until the gates are sent, 1 once they have landed
      // a task with gates keeps its comet on the last stop through the rise and divides it: the gates' comets leave from it at fanFrom and it fades as they part; one without shrinks away with the walk
      const sent = gateNames.length > 0;
      const fadeOut = !sent && u > endU ? smooth(clamp01(walk / 0.6)) : 1;
      const fade = fadeOut * (sent ? 1 - smooth(clamp01((cp - aerial.fanFrom) / aerial.handOff)) : 1);
      const big = 1 + (aerial.boost - 1) * ctx.view.overview; // (larger at the distance of the split)
      flow.set(wr.cometDist(u), ctx.camera, fade * big, ctx.dt);
      // rings: the scan ring is engraved at the core while it holds; a ripple runs out where the comet lands on each later tower
      const R = ctx.rings;
      R.clearAll();
      const stops = wr.stops;
      const core = ctx.lattice.cells[ctx.cellIndex(names[0])];
      if (fade > 0.01 && u > land[0]) {
        const grow = clamp01((u - land[0]) / Math.max(1e-3, stops[0].u1 - land[0] - sec(P.scan.fade)));
        const out = 1 - clamp01((u - stops[0].u1 + sec(P.scan.fade)) / sec(P.scan.fade));
        if (out > 0) {
          R.setShell(ctx.lattice.radius + core.height + 0.045);
          R.set(0, core.normal, core.half * P.scan.radius, P.scan.width * out, Math.max(0.02, smooth(grow)));
        }
      }
      names.forEach((n, i) => {
        if (i === 0 || i + 1 >= RING_SLOTS) return;
        const k = (u - land[i]) / sec(P.ripple.sec);
        if (k <= 0 || k >= 1) return;
        ripple(i + 1, n, k);
      });
      names.forEach((n, i) => ctx.hilite(n, pulse(u, land[i], sec(P.holdSec)) * fade * motion.hilite.strike));
      // the fan-out: the gates' comets leave the last stop together, fly in parallel and land together; a ripple runs out where each lands, and they shrink away before the Proof pull-back
      const gateFade = cp >= aerial.fanFrom ? smooth(clamp01((cp - aerial.fanFrom) / aerial.gateIn)) * (1 - smooth(clamp01((cp - aerial.gateFadeOut[0]) / (aerial.gateFadeOut[1] - aerial.gateFadeOut[0])))) : 0;
      gateFlows.forEach((gf, i) => {
        if (i >= gateRoutes.length || gateFade <= 0) { gf.hide(); return; }
        const r = gateRoutes[i];
        gf.set(r.length * easeLeg(fan), ctx.camera, gateFade * big, ctx.dt);
        if (fan >= 1) {
          const k = (cp - aerial.fanTo) / RIPPLE_P;
          if (k > 0 && k < 1) ripple(4 + i, gateNames[i], k);
        }
        ctx.hilite(gateNames[i], pulse(cp, aerial.fanTo, RIPPLE_P) * gateFade * motion.hilite.strike);
      });
    },
    clear() {
      flow.hide();
      gateFlows.forEach((f) => f.hide());
      ctx.rings.clearAll();
    },
  };
}
