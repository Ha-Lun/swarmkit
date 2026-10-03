// The follow route: a pure module (three maths only, no scene, no DOM). A task's journey is a list of towers (the core first, then the agents it visits). The comet flies from cap to cap
// (a Route at the usual lift, every leg eased like every other comet leg) and rests on each cap for the hold; the camera follows it in a low orbit: a viewpoint per stop, `back` behind the
// comet's arrival direction and `up` above the cap, joined by a Route that stays over the columns, on the comet's own timing shifted by `lagSec` (it leaves after the comet and arrives
// after it, so it trails). The camera always looks at the comet, with up = the radial at the camera, so the horizon stays level whatever side of the globe it is on.
// The route parameter u (0..1) runs over the journey in seconds (length = seconds x walkCfg.rate); everything here is a pure function of it.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { motion, walkCfg } from './motion-config';
import { clearRadius, easeLeg, entryPoint, raise, Route } from './routes';
import type { Lattice } from './honeycomb';
import type { WalkParams, WalkPose, WalkRoute, WalkStopSpec } from './walk';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The route for the towers in `visit` (in order; the first is the core, where the comet is already waiting when the journey starts). */
export function createFollowRoute(lattice: Lattice, visit: WalkStopSpec[]): WalkRoute {
  const cells = lattice.cells;
  const P = motion.packet;
  const picked = visit.map((v) => {
    const c = cells.find((x) => !x.moon && x.agent?.name === v.name);
    if (!c) throw new Error(`follow: no tower for ${v.name}`);
    return c;
  });
  const n = picked.length;
  const caps = picked.map((c) => raise(c.pos.clone().addScaledVector(c.normal, c.base))); // where the comet rests on each cap
  const clear = clearRadius(lattice);
  // (a single stop has no leg: a degenerate route keeps the comet's path source valid)
  const comet = new Route(n > 1 ? caps : [caps[0], caps[0]], clear);

  // ---- timeline, seconds: the comet lands at tL[i], holds, leaves at tD[i] ----
  const tL: number[] = [], tD: number[] = [];
  let t = 0;
  visit.forEach((v, i) => {
    if (i > 0) t += Math.max(P.minLegSec, comet.legs[i - 1].len / P.meanSpeed);
    tL.push(t);
    t += v.holdSec ?? walkCfg.dwellSec;
    tD.push(t);
  });
  // a short journey (a task with one stop) holds its last stop on: the autoplay speed of a very short route is far above the tail's and would sweep the rise past
  tD[n - 1] = Math.max(tD[n - 1], walkCfg.minSec);
  const total = tD[n - 1];

  // ---- the camera's viewpoints ----
  const tangentIn = (i: number, out: Vector3) => {
    const nrm = picked[i].normal;
    out.copy(caps[i]).sub(i > 0 ? caps[i - 1] : entryPoint(lattice));
    out.addScaledVector(nrm, -out.dot(nrm));
    return out.lengthSq() < 1e-8 ? out.set(0, 1, 0).addScaledVector(nrm, -nrm.y).normalize() : out.normalize();
  };
  const tmp = new Vector3();
  const views = caps.map((cap, i) => cap.clone().addScaledVector(tangentIn(i, tmp), -walkCfg.back).addScaledVector(picked[i].normal, walkCfg.up));
  const camRoute = new Route(n > 1 ? views : [views[0], views[0]], clear + walkCfg.clearMargin);

  /** distance along `route` at time `s` (seconds), the comet's legs eased inside their windows [tD[i-1], tL[i]] */
  const distAt = (route: Route, s: number): number => {
    for (let i = 1; i < n; i++) {
      if (s < tL[i]) return s <= tD[i - 1] ? route.stopAt[i - 1] : route.stopAt[i - 1] + (route.stopAt[i] - route.stopAt[i - 1]) * easeLeg((s - tD[i - 1]) / (tL[i] - tD[i - 1]));
    }
    return route.stopAt[n - 1];
  };
  const cometDist = (u: number) => (n > 1 ? distAt(comet, u * total) : 0);

  const stops = picked.map((c, i) => ({ name: visit[i].name, band: c.agent!.band as string, u0: tL[i] / total, u1: tD[i] / total, tower: c.normal.clone() }));
  const fresh = (): WalkPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 55, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 });
  const m = new Matrix4(), pos = new Vector3(), tgt = new Vector3(), f = new Vector3();

  return {
    length: total * walkCfg.rate,
    stops,
    cometRoute: comet,
    cometDist,
    sample(u, p: WalkParams, out: WalkPose = fresh()) {
      const s = clamp01(u) * total;
      camRoute.pointAt(n > 1 ? distAt(camRoute, s - walkCfg.lagSec) : 0, pos);
      comet.pointAt(n > 1 ? distAt(comet, s) : 0, tgt);
      out.up.copy(pos).normalize();
      m.lookAt(pos, tgt, out.up);
      out.quaternion.setFromRotationMatrix(m);
      out.position.copy(pos);
      f.copy(tgt).sub(pos);
      out.forward.copy(f.addScaledVector(out.up, -f.dot(out.up)).normalize());
      out.fov = p.fov;
      out.ground = 0;
      let i = 0;
      while (i < n - 1 && s > tD[i]) i++;
      out.stop = i;
      return out;
    },
  };
}
