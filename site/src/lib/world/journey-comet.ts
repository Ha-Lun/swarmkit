// The task's comet on the ground. It is a pure function of the walk's route parameter u (so scrubbing, autoplay and the wheel stay exact, both ways): it comes in from outside the globe
// during the dive, lands on the core, and then leaves each tower a moment before the walker does and lands on the next one's cap a moment before the walker stops, where it rests for the
// hold. The path is a great-circle leg between the caps (raised over the columns, routes.ts), eased like every other comet leg. Rings and the arrival lift are drawn from the same u.
import { Vector3 } from 'three';
import { motion, walkCfg, walkRamp } from './motion-config';
import { clearRadius, easeLeg, entryPoint, Route, type Flow } from './routes';
import type { WalkRoute } from './walk';
import type { WorldCtx } from './types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);

export interface JourneyComet {
  /** draw the comet, its rings and its arrival lift for route parameter `u` (unclamped: negative during the dive, above 1 during the rise); `walk` = the walk weight */
  update(route: WalkRoute | null, u: number, walk: number): void;
  /** hide everything (leaving the chapter) */
  clear(): void;
}

export function createJourneyComet(ctx: WorldCtx, flow: Flow): JourneyComet {
  const P = motion.packet;
  let builtFor: WalkRoute | null = null;
  let route: Route | null = null;
  let names: string[] = [];
  /** per stop: u at which the comet starts its leg to it, u at which it lands */
  let start: number[] = [], land: number[] = [];
  let endU = 1;
  const head = new Vector3();

  const capTop = (name: string) => {
    const c = ctx.lattice.cells[ctx.cellIndex(name)];
    // The walker looks UP at the cap from the street, so anything resting on it is behind the tower's own near edge: the comet hovers cometHover above the cap's centre instead.
    return c.pos.clone().addScaledVector(c.normal, c.base + walkCfg.towerGrow + walkCfg.cometHover); // (the walk lifts the towers by towerGrow)
  };

  function build(wr: WalkRoute) {
    builtFor = wr;
    names = wr.stops.map((s) => s.name);
    const L = wr.length;
    const leadU = (walkCfg.cometLeadSec * walkCfg.rate) / L, arriveU = (walkCfg.cometArriveSec * walkCfg.rate) / L;
    const dive = (walkRamp.inFrom - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom); // the comet comes down with the dive
    start = []; land = [];
    wr.stops.forEach((s, i) => {
      const a = i === 0 ? dive : wr.stops[i - 1].u1 - leadU;
      const b = Math.max(a + 0.01, s.u0 - arriveU);
      start.push(a); land.push(b);
    });
    endU = wr.stops[wr.stops.length - 1].u1;
    route = new Route([entryPoint(ctx.lattice), ...names.map(capTop)], clearRadius(ctx.lattice) + walkCfg.towerGrow);
    flow.setRoute(route);
  }

  /** distance along the comet's route at u */
  function distAt(u: number): number {
    const r = route!;
    for (let i = 0; i < start.length; i++) {
      if (u <= land[i]) return u <= start[i] ? r.stopAt[i] : r.stopAt[i] + (r.stopAt[i + 1] - r.stopAt[i]) * easeLeg((u - start[i]) / (land[i] - start[i]));
    }
    return r.length;
  }

  const pulse = (u: number, at: number, dur: number) => clamp01((u - at) / 0.02) * (1 - clamp01((u - at - 0.02) / dur)); // (a quick rise, then a fade over `dur` in u)

  return {
    update(wr, u, walk) {
      if (!wr || wr.stops.length === 0) { this.clear(); return; }
      if (builtFor !== wr) build(wr);
      const L = wr.length;
      const sec = (s: number) => (s * walkCfg.rate) / L; // seconds -> route parameter
      // visible from the start of the dive until the walker has risen away again (the weight falls with the rise)
      const fadeIn = clamp01((u - start[0]) / sec(P.fadeSec));
      const fadeOut = u > endU ? smooth(clamp01(walk / 0.6)) : 1;
      const fade = fadeIn * fadeOut;
      flow.set(distAt(u), ctx.camera, fade, ctx.dt);
      flow.headAt(distAt(u), head);
      ctx.view.cometHead.copy(head);
      ctx.view.cometGaze = u >= land[0] - sec(1) ? fade : 0; // (from the core's landing on: before it the comet is still coming down the sky)
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
        if (i === 0 || i + 1 >= 8) return;
        const k = (u - land[i]) / sec(P.ripple.sec);
        if (k <= 0 || k >= 1) return;
        const c = ctx.lattice.cells[ctx.cellIndex(n)];
        R.setShell(ctx.lattice.radius + c.height + 0.045); // (the shell is one radius for every ring: the last one set wins, which is the tower being arrived at)
        R.set(i + 1, c.normal, c.half * (0.3 + 0.62 * k), P.ripple.width, 1 - smooth(clamp01((k - 0.5) / 0.5)));
      });
      names.forEach((n, i) => ctx.hilite(n, pulse(u, land[i], sec(P.holdSec)) * fade * motion.hilite.strike));
    },
    clear() {
      ctx.view.cometGaze = 0;
      flow.hide();
      ctx.rings.clearAll();
    },
  };
}
