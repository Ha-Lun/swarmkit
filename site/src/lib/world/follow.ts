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


/** The route for the towers in `visit` (in order; the first is the core). The comet starts outside the globe at the entry point, where it waits until u = 0, flies in to the core
 *  (the entry leg), and then from tower to tower. */
export function createFollowRoute(lattice: Lattice, visit: WalkStopSpec[]): WalkRoute {
  const cells = lattice.cells;
  const P = motion.packet;
  const picked = visit.map((v) => {
    const c = cells.find((x) => !x.moon && x.agent?.name === v.name);
    if (!c) throw new Error(`follow: no tower for ${v.name}`);
    return c;
  });
  const n = picked.length;
  const entry = entryPoint(lattice);
  const caps = picked.map((c) => raise(c.pos.clone().addScaledVector(c.normal, c.base))); // where the comet rests on each cap
  const clear = clearRadius(lattice);
  // the comet's points: the entry, then each cap; leg k runs from point k to point k + 1 (leg 0 is the entry leg)
  const comet = new Route([entry, ...caps], clear);

  // ---- timeline, seconds: leg k departs at dep[k] and arrives at arr[k]; the comet then rests on stop k until dep[k + 1] ----
  const dep: number[] = [], arr: number[] = [], tL: number[] = [], tD: number[] = [];
  let t = 0;
  visit.forEach((v, k) => {
    dep.push(t);
    t += k === 0 ? Math.max(walkCfg.entrySec, comet.legs[0].len / P.meanSpeed) : Math.max(P.minLegSec, comet.legs[k].len / P.meanSpeed);
    arr.push(t);
    tL.push(t);
    t += v.holdSec ?? walkCfg.dwellSec;
    tD.push(t);
  });
  // a short journey (a task with one stop) holds its last stop on: the autoplay speed of a very short route is far above the tail's and would sweep the rise past
  tD[n - 1] = Math.max(tD[n - 1], walkCfg.minSec);
  const total = tD[n - 1];

  // ---- the camera's viewpoints: one behind and above the comet at the entry, then one per stop ----
  const tmp = new Vector3(), tmp2 = new Vector3();
  const views: Vector3[] = [];
  {
    // at the entry the camera sits behind the waiting comet, away from the globe, so it sees the comet ahead and the planet below it
    tmp.copy(caps[0]).sub(entry).normalize();
    views.push(entry.clone().addScaledVector(tmp, -walkCfg.entryBack).addScaledVector(tmp2.copy(entry).normalize(), walkCfg.entryUp));
  }
  picked.forEach((c, i) => {
    const nrm = c.normal;
    tmp.copy(caps[i]).sub(i > 0 ? caps[i - 1] : entry);
    tmp.addScaledVector(nrm, -tmp.dot(nrm));
    if (tmp.lengthSq() < 1e-8) tmp.set(0, 1, 0).addScaledVector(nrm, -nrm.y);
    tmp.normalize();
    views.push(caps[i].clone().addScaledVector(tmp, -walkCfg.back).addScaledVector(nrm, walkCfg.up));
  });
  const camRoute = new Route(views, clear + walkCfg.clearMargin);

  /** distance along `route` (one of the two, whose points are the entry and then the stops) at time `s`: each leg is eased inside its window [dep, arr] */
  const distAt = (route: Route, s: number): number => {
    for (let k = 0; k < n; k++) {
      if (s < arr[k]) return s <= dep[k] ? route.stopAt[k] : route.stopAt[k] + (route.stopAt[k + 1] - route.stopAt[k]) * easeLeg((s - dep[k]) / (arr[k] - dep[k]));
    }
    return route.stopAt[n];
  };
  const cometDist = (u: number) => distAt(comet, u * total);

  const stops = picked.map((c, i) => ({ name: visit[i].name, band: c.agent!.band as string, u0: tL[i] / total, u1: tD[i] / total, tower: c.normal.clone() }));
  const fresh = (): WalkPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 55, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 });
  const m = new Matrix4(), pos = new Vector3(), tgt = new Vector3(), f = new Vector3();

  return {
    length: total * walkCfg.rate,
    stops,
    cometRoute: comet,
    cometDist,
    sample(u, p: WalkParams, out: WalkPose = fresh()) {
      const s = Math.min(1, u) * total; // (before the start, u < 0: the comet waits at the entry and the camera at the entry viewpoint)
      camRoute.pointAt(distAt(camRoute, s - walkCfg.lagSec), pos);
      comet.pointAt(distAt(comet, s), tgt);
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
