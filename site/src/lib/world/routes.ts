// Comet routes and their velocity profile. A route is a chain of great-circle legs that hug a body (the globe, or the moon about its own centre) at one constant lift
// (no horizon zigzag), except the entry leg, which descends onto the first stop. Every leg eases in and out (easeLeg, below); the timing is the caller's (follow.ts).
import { Vector3 } from 'three';
import { look } from './config';
import { createPacket, type PathSource, type Packet } from './packet';
import type { Lattice } from './honeycomb';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** smootherstep: zero velocity and acceleration at both ends, peak speed 1.875x the mean */
export const easeLeg = (t: number) => { const x = clamp01(t); return x * x * x * (x * (x * 6 - 15) + 10); };

interface Leg {
  a: Vector3; b: Vector3; // unit directions
  ang: number; ra: number; rb: number;
  d0: number; len: number;
  table: Float32Array; // cumulative length at TABLE evenly spaced parameter values
}
const TABLE = 48;

export class Route implements PathSource {
  readonly legs: Leg[] = [];
  length = 0;
  /** distance along the route at which each stop sits (stops[0] = 0) */
  readonly stopAt: number[] = [0];

  /** Stops are world points; each leg keeps the radius of its two ends (a leg from far out to the surface decays onto it).
   *  `clear` (a radius, see clearRadius) is the least radius a leg may fly at between its two ends, so it arcs over tall columns. Radii are about `origin`, the body's centre. */
  constructor(stops: Vector3[], private readonly clear = 0, private readonly origin = new Vector3()) {
    let d = 0;
    for (let i = 1; i < stops.length; i++) {
      const A = stops[i - 1].clone().sub(origin), B = stops[i].clone().sub(origin);
      const ra = A.length(), rb = B.length();
      const a = A.clone().divideScalar(ra), b = B.clone().divideScalar(rb);
      const ang = Math.acos(Math.min(1, Math.max(-1, a.dot(b))));
      const leg: Leg = { a, b, ang, ra, rb, d0: d, len: 0, table: new Float32Array(TABLE + 1) };
      const p = new Vector3(), q = new Vector3();
      let acc = 0;
      this.legPoint(leg, 0, p);
      for (let k = 1; k <= TABLE; k++) {
        this.legPoint(leg, k / TABLE, q);
        acc += q.distanceTo(p);
        leg.table[k] = acc;
        p.copy(q);
      }
      leg.len = acc;
      d += acc;
      this.legs.push(leg);
      this.stopAt.push(d);
    }
    this.length = d;
  }

  private legPoint(l: Leg, t: number, out: Vector3) {
    const s = Math.sin(l.ang);
    if (s < 1e-5) out.copy(l.a);
    else out.copy(l.a).multiplyScalar(Math.sin((1 - t) * l.ang) / s).addScaledVector(l.b, Math.sin(t * l.ang) / s);
    // constant lift between equal radii; a descent (ra > rb) decays onto the surface, a climb rises off it
    let r = l.ra >= l.rb ? l.rb + (l.ra - l.rb) * (1 - t) * (1 - t) : l.ra + (l.rb - l.ra) * t * t;
    if (this.clear > 0) { // rise over the terrain within the first and last stretch of the leg, so the comet never clips a neighbour
      const k = Math.min(1, t / 0.15) * Math.min(1, (1 - t) / 0.15);
      r += Math.max(0, this.clear - Math.max(l.ra, l.rb)) * k * k * (3 - 2 * k);
    }
    return out.normalize().multiplyScalar(r);
  }

  /** point at distance d along the route (clamped) */
  pointAt(d: number, out: Vector3): Vector3 {
    const legs = this.legs;
    if (!legs.length) return out.set(0, 0, 0);
    const x = Math.min(this.length, Math.max(0, d));
    let i = 0;
    while (i < legs.length - 1 && x > legs[i].d0 + legs[i].len) i++;
    const l = legs[i];
    const local = Math.min(l.len, Math.max(0, x - l.d0));
    // invert the table (piecewise linear in the parameter)
    let lo = 0, hi = TABLE;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (l.table[mid] <= local) lo = mid; else hi = mid; }
    const span = l.table[hi] - l.table[lo];
    const t = (lo + (span > 1e-9 ? (local - l.table[lo]) / span : 0)) / TABLE;
    return this.legPoint(l, t, out).add(this.origin);
  }
}

/** A leg from one body to another: a cubic Bezier that leaves the first point along `nA` (its surface normal) and settles onto the second along `nB`, so it lifts off one body and lands on
 *  the other from above, never through either. `lift` is how far out (world units) the two inner control points stand. */
export class Transfer implements PathSource {
  length = 0;
  private readonly p: Vector3[];
  private readonly table = new Float32Array(TABLE + 1);
  constructor(a: Vector3, nA: Vector3, b: Vector3, nB: Vector3, lift: number) {
    this.p = [a.clone(), a.clone().addScaledVector(nA, lift), b.clone().addScaledVector(nB, lift), b.clone()];
    const p = new Vector3(), q = new Vector3();
    this.at(0, p);
    for (let k = 1; k <= TABLE; k++) { this.at(k / TABLE, q); this.length += q.distanceTo(p); this.table[k] = this.length; p.copy(q); }
  }
  private at(t: number, out: Vector3) {
    const [a, b, c, d] = this.p, s = 1 - t;
    return out.copy(a).multiplyScalar(s * s * s).addScaledVector(b, 3 * s * s * t).addScaledVector(c, 3 * s * t * t).addScaledVector(d, t * t * t);
  }
  pointAt(d: number, out: Vector3): Vector3 {
    const x = Math.min(this.length, Math.max(0, d));
    let lo = 0, hi = TABLE;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.table[mid] <= x) lo = mid; else hi = mid; }
    const span = this.table[hi] - this.table[lo];
    return this.at((lo + (span > 1e-9 ? (x - this.table[lo]) / span : 0)) / TABLE, out);
  }
}

/** Legs end to end (each a one-leg Route or a Transfer): one path the comet and the camera travel, with the distance at which each stop sits. */
export class Chain implements PathSource {
  readonly length: number;
  /** distance along the chain at which each stop sits (stopAt[0] = 0, stopAt[k + 1] = the end of leg k) */
  readonly stopAt: number[] = [0];
  constructor(readonly legs: PathSource[]) {
    let d = 0;
    for (const l of legs) { d += l.length; this.stopAt.push(d); }
    this.length = d;
  }
  pointAt(d: number, out: Vector3): Vector3 {
    const n = this.legs.length;
    if (!n) return out.set(0, 0, 0);
    let k = 0;
    while (k < n - 1 && d > this.stopAt[k + 1]) k++;
    return this.legs[k].pointAt(d - this.stopAt[k], out);
  }
}

export interface Flow {
  packet: Packet;
  setRoute(route: PathSource): void;
  /** draw the comet at distance d along its route, fade 0..1 (size, not alpha) */
  set(d: number, camera: import('three').Camera, fade: number, dt: number): void;
  hide(): void;
  dispose(): void;
}

export function createFlow(accent: string): Flow {
  const cfg = { ...look.packet };
  const packet = createPacket(accent, cfg);
  packet.group.visible = false;
  let route: PathSource | null = null;
  const flow: Flow = {
    packet,
    setRoute(r) {
      route = r;
      packet.reset();
    },
    set(d, camera, fade, dt) {
      if (!route) return;
      packet.group.visible = fade > 0.003;
      if (packet.group.visible) packet.update(route, d, camera, look.packet, fade, dt);
      else packet.reset();
    },
    hide() {
      packet.group.visible = false;
      packet.reset();
    },
    dispose: () => packet.dispose(),
  };
  return flow;
}

/** Off-globe point where a task comes in from, derived from the globe radius. */
export function entryPoint(lattice: Lattice, out = new Vector3()): Vector3 {
  return out.set(-0.8, 0.45, 0.55).normalize().multiplyScalar(lattice.radius * 1.55);
}

/** Lift a cell top radially by the comet height, so the route hugs the panels at one constant radius. */
export function raise(p: Vector3, out = new Vector3()): Vector3 {
  return out.copy(p).setLength(p.length() + look.packet.height);
}

/** Radius a comet leg must clear: the tallest a column can ever stand (resting height plus its full piston stroke) plus a little air.
 *  Terrain and stroke are bounded (honeycomb.ts), so one radius is enough and the comet never meets a rod mid-stroke. */
export function clearRadius(lattice: Lattice): number {
  const tallest = lattice.cells.reduce((m, c) => (c.moon ? m : Math.max(m, c.reach)), 0);
  return lattice.radius + tallest + 0.1;
}
