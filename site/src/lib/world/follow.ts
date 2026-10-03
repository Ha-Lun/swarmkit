// The follow route: a pure module (three maths only, no scene, no DOM). A task's journey is a list of towers (the core first, then the agents it visits). The comet flies from cap to cap
// (a Route at the usual lift, every leg eased like every other comet leg) and rests on each cap for the hold; the camera follows it in a low orbit: a viewpoint per stop, `back` behind the
// comet's arrival direction and `up` above the cap, joined by a Route that stays over the columns, on the comet's own timing shifted by `lagSec` (it leaves after the comet and arrives
// after it, so it trails). The camera always looks at the comet, with up = the radial at the camera, so the horizon stays level whatever side of the globe it is on.
// The route parameter u (0..1) runs over the journey in seconds (length = seconds x walkCfg.rate); everything here is a pure function of it.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { aerial, motion, walkCfg } from './motion-config';
import { look } from './config';
import { Chain, clearRadius, easeLeg, entryPoint, Route, Transfer } from './routes';
import type { Cell, Lattice } from './honeycomb';
import type { WalkParams, WalkPose, WalkRoute, WalkStopSpec } from './walk';


/** The route for the towers in `visit` (in order; the first is the core). The comet starts outside the globe at the entry point, where it waits until u = 0, flies in to the core
 *  (the entry leg), and then from tower to tower. A tower may be on the moon: the legs on the moon hug it about its own centre, and the leg across is a Transfer that lifts off the globe and
 *  settles onto the moon (the moon is parked at home while the walk runs: spinWeight is 0 there). */
export function createFollowRoute(lattice: Lattice, visit: WalkStopSpec[]): WalkRoute {
  const cells = lattice.cells;
  const P = motion.packet;
  const picked = visit.map((v) => {
    const c = cells.find((x) => x.agent?.name === v.name);
    if (!c) throw new Error(`follow: no tower for ${v.name}`);
    return c;
  });
  const n = picked.length;
  const moonC = lattice.moon.centre;
  const onMoon = [false, ...picked.map((c) => c.moon)]; // per route point: the entry, then each stop
  const normalOf = (c: Cell) => c.home?.normal ?? c.normal;
  const entry = entryPoint(lattice);
  const caps = picked.map((c) => (c.home?.pos ?? c.pos).clone().addScaledVector(normalOf(c), c.base + look.packet.height)); // where the comet rests on each cap
  const clear = clearRadius(lattice);
  const moonClear = cells.reduce((m, c) => (c.moon ? Math.max(m, c.bodyRadius + c.reach) : m), 0) + 0.1;
  const points = [entry, ...caps];
  const outward = (i: number, p: Vector3) => (onMoon[i] ? p.clone().sub(moonC) : p.clone()).normalize(); // a route point's direction away from its body's centre
  /** one leg per hop: on the globe, on the moon (about its centre), or across */
  const legsOf = (pts: Vector3[], margin: number, lift: number) => pts.slice(1).map((b, k) => {
    const a = pts[k];
    if (onMoon[k] && onMoon[k + 1]) return new Route(a, b, moonClear + margin, moonC);
    if (!onMoon[k] && !onMoon[k + 1]) return new Route(a, b, clear + margin);
    return new Transfer(a, outward(k, a), b, outward(k + 1, b), lift);
  });
  const comet = new Chain(legsOf(points, 0, walkCfg.transferLift));

  // ---- timeline, seconds: leg k departs at dep[k] and arrives at arr[k] (the comet lands on stop k); it rests there until tD[k] = dep[k + 1] ----
  const dep: number[] = [], arr: number[] = [], tD: number[] = [];
  let t = 0;
  visit.forEach((v, k) => {
    dep.push(t);
    const len = comet.legs[k].length;
    t += k === 0 ? Math.max(walkCfg.entrySec, len / P.meanSpeed) : onMoon[k] !== onMoon[k + 1] ? Math.max(walkCfg.transferSec, len / P.meanSpeed) : Math.max(onMoon[k] ? walkCfg.moonLegSec : P.minLegSec, len / P.meanSpeed);
    arr.push(t);
    t += v.holdSec ?? walkCfg.dwellSec;
    tD.push(t);
  });
  // a short journey (a task with one stop) holds its last stop on: the autoplay speed of a very short route is far above the tail's and would sweep the rise past
  tD[n - 1] = Math.max(tD[n - 1], walkCfg.minSec);
  const total = tD[n - 1];

  // ---- the camera's viewpoints: one behind and above the comet at the entry, then one per stop. On the moon (too small to fly low over) the camera stands off and orbits it instead,
  // out along the stop's normal leaned towards the moon's face (where its towers are), so the whole moon is in view with the stop facing the camera ----
  const tmp = new Vector3(), tmp2 = new Vector3();
  const views: Vector3[] = [];
  {
    // at the entry the camera sits behind the waiting comet, away from the globe, so it sees the comet ahead and the planet below it
    tmp.copy(caps[0]).sub(entry).normalize();
    views.push(entry.clone().addScaledVector(tmp, -walkCfg.entryBack).addScaledVector(tmp2.copy(entry).normalize(), walkCfg.entryUp));
  }
  const face = lattice.moon.normal;
  picked.forEach((c, i) => {
    const nr = normalOf(c);
    if (c.moon) { views.push(moonC.clone().addScaledVector(tmp.copy(face).multiplyScalar(walkCfg.moonFace).add(nr).normalize(), lattice.moon.radius * walkCfg.moonOrbit)); return; }
    tmp.copy(caps[i]).sub(i > 0 ? caps[i - 1] : entry);
    tmp.addScaledVector(nr, -tmp.dot(nr));
    if (tmp.lengthSq() < 1e-8) tmp.set(0, 1, 0).addScaledVector(nr, -nr.y);
    tmp.normalize();
    views.push(caps[i].clone().addScaledVector(tmp, -walkCfg.back).addScaledVector(nr, walkCfg.up));
  });
  const camRoute = new Chain(legsOf(views, walkCfg.clearMargin, walkCfg.transferLift * 1.4));

  /** the leg in progress at time `s` and how far along it is (eased; 0 while resting before it, 1 once it has landed) */
  const legAt = (s: number): [number, number] => {
    for (let k = 0; k < n; k++) if (s < arr[k]) return [k, s <= dep[k] ? 0 : easeLeg((s - dep[k]) / (arr[k] - dep[k]))];
    return [n - 1, 1];
  };
  /** distance along `route` (one of the two chains, whose points are the entry and then the stops) at time `s` */
  const distAt = (route: Chain, s: number): number => { const [k, f] = legAt(s); return route.stopAt[k] + (route.stopAt[k + 1] - route.stopAt[k]) * f; };
  /** 0 on the globe, 1 on the moon, eased across the transfer: on the globe "up" is its radial, on the moon (seen from outside, looking in) the world's up */
  const moonAt = (s: number): number => { const [k, f] = legAt(s); return onMoon[k] === onMoon[k + 1] ? (onMoon[k + 1] ? 1 : 0) : onMoon[k + 1] ? f : 1 - f; };
  const cometDist = (u: number) => distAt(comet, u * total);

  const stops = picked.map((c, i) => ({ name: visit[i].name, band: c.agent!.band as string, u0: arr[i] / total, u1: tD[i] / total }));
  const fresh = (): WalkPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 55, up: new Vector3(), forward: new Vector3(), stop: 0 });
  const WORLD_UP = new Vector3(0, 1, 0);
  const m = new Matrix4(), pos = new Vector3(), tgt = new Vector3(), f = new Vector3();

  return {
    length: total * walkCfg.rate,
    stops,
    cometRoute: comet,
    cometDist,
    sample(u, p: WalkParams, out: WalkPose = fresh()) {
      const s = Math.min(1, u) * total; // (before the start, u < 0: the comet waits at the entry and the camera at the entry viewpoint)
      const sc = s - walkCfg.lagSec;
      camRoute.pointAt(distAt(camRoute, sc), pos);
      comet.pointAt(distAt(comet, s), tgt);
      const mw = moonAt(sc);
      if (mw > 0) tgt.lerp(moonC, mw * walkCfg.moonAim); // (on the moon the camera aims between the comet and the moon's centre: the hops are short and quick, and the moon stays framed)
      out.up.copy(pos).normalize();
      if (mw > 0) out.up.multiplyScalar(1 - mw).addScaledVector(WORLD_UP, mw).normalize();
      m.lookAt(pos, tgt, out.up);
      out.quaternion.setFromRotationMatrix(m);
      out.position.copy(pos);
      f.copy(tgt).sub(pos);
      out.forward.copy(f.addScaledVector(out.up, -f.dot(out.up)).normalize());
      out.fov = p.fov;
      let i = 0;
      while (i < n - 1 && s > tD[i]) i++;
      out.stop = i;
      return out;
    },
  };
}

/** The camera pose for the gate split: it looks at the middle of the towers named in `names` (the last stop and the gates) from the side they face, far enough out to hold them all in frame.
 *  The globe is parked during the walk, so the tower positions are the layout's own. Returns null if a name has no tower. */
export function gateViewOf(lattice: Lattice, names: string[]): { pos: Vector3; target: Vector3 } | null {
  const cs = names.map((n) => lattice.cells.find((c) => !c.moon && c.agent?.name === n));
  if (cs.some((c) => !c)) return null;
  const R = lattice.radius, dir = new Vector3(), target = new Vector3();
  cs.forEach((c) => { dir.add(c!.normal); target.add(c!.pos); });
  dir.normalize();
  target.divideScalar(cs.length);
  let span = 0;
  cs.forEach((a) => cs.forEach((b) => (span = Math.max(span, a!.pos.distanceTo(b!.pos)))));
  const v = aerial.view, above = Math.min(v.max, Math.max(v.min, (span / R) * v.fit));
  return { pos: dir.multiplyScalar(R * (1 + above)), target };
}
