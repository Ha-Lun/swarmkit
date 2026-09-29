// The walk route: a pure module (three maths only, no scene, no DOM) shared by the /lookdev walk bench and, later, the story.
// The camera stands on the globe, up = the local surface normal, and walks from stand point to stand point, one short of each
// agent tower in routing order (core, t1, domain, gates). Each leg is a great-circle arc (heading = along the arc, toward the
// next tower); at every stop the camera dwells and turns to the next leg's heading. Orientation is built from quaternions
// (right, up, back basis, then a pitch about `right`): no lookAt, no fixed world up, so the horizon can roll with the sphere.
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { Lattice } from './honeycomb';

export interface WalkParams {
  /** camera height above the smoothed local column top, world units */
  eye: number;
  /** vertical FOV, degrees (passed through to the pose) */
  fov: number;
  /** degrees the view is tipped below the horizon */
  pitchDeg: number;
}

export interface WalkStop {
  name: string;
  band: string;
  /** route parameter range (0..1) the camera dwells at this stop */
  u0: number;
  u1: number;
  /** unit normal of the tower cell (the landmark) and of the stand point */
  tower: Vector3;
  stand: Vector3;
}

export interface WalkPose {
  position: Vector3;
  quaternion: Quaternion;
  fov: number;
  up: Vector3;
  /** unit heading in the tangent plane, before pitch */
  forward: Vector3;
  /** smoothed column top under the camera, above the sphere */
  ground: number;
  /** index of the tower being approached (or dwelt at) */
  stop: number;
}

export interface WalkRoute {
  /** total route parameter length in world units (legs at globe radius, plus dwell allowances) */
  length: number;
  stops: WalkStop[];
  sample(u: number, p: WalkParams, out?: WalkPose): WalkPose;
  /** smoothed column top (above the sphere) in the direction `dir` */
  groundTop(dir: Vector3): number;
}

const BAND_ORDER = ['core', 't1', 'domain', 'gate'] as const;
const DWELL = 3; // world units of route parameter spent turning at an ordinary stop
const DWELL_BAND = 5; // ... at the last tower of a band
const STOP_CELLS = 1.2; // stand this many cell spacings short of the tower
const START_BACK = 0.6; // rad: the walk starts this far north (+Y) of the core cell

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (t: number) => t * t * (3 - 2 * t);

interface Leg { e1: Vector3; e2: Vector3; tEnd: number }
type Seg = { kind: 'leg'; i: number; s0: number; s1: number } | { kind: 'dwell'; i: number; s0: number; s1: number };

export function createWalkRoute(lattice: Lattice): WalkRoute {
  const R = lattice.radius;
  const globe = lattice.cells.filter((c) => !c.moon);

  // typical angle between neighbouring cell centres: the unit of the route (stand-off, ground smoothing)
  let sum = 0, n = 0;
  for (const c of globe) for (const j of c.neighbours) {
    const o = lattice.cells[j];
    if (o.moon) continue;
    sum += Math.acos(clamp(c.normal.dot(o.normal), -1, 1)); n++;
  }
  const spacing = sum / Math.max(1, n);
  const sigma = 0.6 * spacing;
  const cosCut = Math.cos(3 * sigma);

  function groundTop(dir: Vector3): number {
    let w = 0, h = 0;
    for (const c of globe) {
      const d = c.normal.dot(dir);
      if (d < cosCut) continue;
      const th = Math.acos(clamp(d, -1, 1)) / sigma;
      const k = Math.exp(-th * th);
      w += k; h += k * c.base;
    }
    return w > 0 ? h / w : 0;
  }

  // ---- tower order: bands in routing order; inside a band, nearest neighbour from the previous tower ----
  const towers: { name: string; band: string; normal: Vector3 }[] = [];
  let prev = new Vector3(0, 0, 1);
  for (const band of BAND_ORDER) {
    const pool = globe.filter((c) => c.agent?.band === band);
    // t1 keeps the stated routing order (explore, git-specialist, junior-dev = by name); larger bands go nearest-neighbour
    if (band === 't1') pool.sort((a, b) => a.agent!.name.localeCompare(b.agent!.name));
    while (pool.length) {
      let best = 0;
      if (band !== 't1') for (let k = 1; k < pool.length; k++) if (pool[k].normal.dot(prev) > pool[best].normal.dot(prev)) best = k;
      const c = pool.splice(best, 1)[0];
      towers.push({ name: c.agent!.name, band, normal: c.normal.clone() });
      prev = c.normal;
    }
  }

  // ---- legs: great-circle arcs from stand point to stand point, heading toward the next tower all the way ----
  const dStop = STOP_CELLS * spacing;
  const legs: Leg[] = [];
  const stands: Vector3[] = [];
  let A = new Vector3(0, Math.sin(START_BACK), Math.cos(START_BACK));
  for (const t of towers) {
    const e1 = A.clone();
    const e2 = t.normal.clone().addScaledVector(e1, -e1.dot(t.normal)).normalize();
    const omega = Math.acos(clamp(e1.dot(t.normal), -1, 1));
    const tEnd = Math.max(0, omega - dStop);
    legs.push({ e1, e2, tEnd });
    A = e1.clone().multiplyScalar(Math.cos(tEnd)).addScaledVector(e2, Math.sin(tEnd));
    stands.push(A.clone());
  }

  // ---- segments along the route parameter ----
  const segs: Seg[] = [];
  let s = 0;
  towers.forEach((t, i) => {
    const len = Math.max(0.001, legs[i].tEnd * R);
    segs.push({ kind: 'leg', i, s0: s, s1: s + len }); s += len;
    const lastOfBand = i === towers.length - 1 || towers[i + 1].band !== t.band;
    const dw = lastOfBand ? DWELL_BAND : DWELL;
    segs.push({ kind: 'dwell', i, s0: s, s1: s + dw }); s += dw;
  });
  const total = s;

  const stops: WalkStop[] = towers.map((t, i) => {
    const d = segs[2 * i + 1];
    return { name: t.name, band: t.band, u0: d.s0 / total, u1: d.s1 / total, tower: t.normal, stand: stands[i] };
  });

  // scratch
  const dir = new Vector3(), tin = new Vector3(), tout = new Vector3(), fwd = new Vector3(), right = new Vector3(), back = new Vector3(), tmp = new Vector3();
  const m = new Matrix4(), qBase = new Quaternion(), qPitch = new Quaternion();
  const legDir = (l: Leg, t: number, out: Vector3) => out.copy(l.e1).multiplyScalar(Math.cos(t)).addScaledVector(l.e2, Math.sin(t));
  const legTan = (l: Leg, t: number, out: Vector3) => out.copy(l.e1).multiplyScalar(-Math.sin(t)).addScaledVector(l.e2, Math.cos(t));

  const fresh = (): WalkPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 50, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 });

  return {
    length: total,
    stops,
    groundTop,
    sample(u, p, out = fresh()) {
      const S = clamp(u, 0, 1) * total;
      let k = 0;
      while (k < segs.length - 1 && S > segs[k].s1) k++;
      const sg = segs[k];
      const f = clamp((S - sg.s0) / (sg.s1 - sg.s0), 0, 1);
      const leg = legs[sg.i];
      if (sg.kind === 'leg') {
        const t = smooth(f) * leg.tEnd; // eased: the camera starts and stops each leg at rest
        legDir(leg, t, dir);
        legTan(leg, t, fwd);
      } else {
        legDir(leg, leg.tEnd, dir);
        legTan(leg, leg.tEnd, tin);
        if (sg.i + 1 < legs.length) {
          legTan(legs[sg.i + 1], 0, tout);
          // turn about the local up from the heading the leg arrived on to the heading of the next leg, on one ease
          const ang = Math.atan2(tmp.crossVectors(tin, tout).dot(dir), tin.dot(tout)) * smooth(f);
          tmp.crossVectors(dir, tin);
          fwd.copy(tin).multiplyScalar(Math.cos(ang)).addScaledVector(tmp, Math.sin(ang));
        } else fwd.copy(tin);
      }
      dir.normalize();
      // keep the heading exactly in the tangent plane
      fwd.addScaledVector(dir, -fwd.dot(dir)).normalize();

      const ground = groundTop(dir);
      out.ground = ground;
      out.position.copy(dir).multiplyScalar(R + ground + p.eye);
      out.up.copy(dir);
      out.forward.copy(fwd);
      right.crossVectors(fwd, dir).normalize();
      back.copy(fwd).negate();
      qBase.setFromRotationMatrix(m.makeBasis(right, dir, back));
      qPitch.setFromAxisAngle(right, -(p.pitchDeg * Math.PI) / 180);
      out.quaternion.copy(qPitch).multiply(qBase);
      out.fov = p.fov;
      out.stop = sg.i;
      return out;
    },
  };
}
