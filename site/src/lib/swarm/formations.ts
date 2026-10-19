// Pure particle-formation baker for the swarm showcase (no three.js: runs in node).
// World space: camera looks down -Z from z=11 (fov 45), so everything fits in
// |x| <= 7, |y| <= 4.5, |z| <= 4. All layouts are deterministic per seed.
import type { FormationId } from './beats.ts';

export type Lane = 'agy' | 'opencode';

// Linear RGB 0..1 (sRGB ~ noted): opus white-violet, opencode teal, agy amber,
// verified mint white, merged warm white-gold.
export const PALETTE: {
  opus: [number, number, number];
  opencode: [number, number, number];
  agy: [number, number, number];
  verified: [number, number, number];
  merged: [number, number, number];
} = {
  opus: [0.694, 0.604, 1.0], // ~#d9ccff
  opencode: [0.027, 0.791, 0.578], // ~#2ee6c8
  agy: [1.0, 0.462, 0.063], // ~#ffb547
  verified: [0.578, 1.0, 0.745], // ~#c8ffe0
  merged: [1.0, 0.88, 0.584], // ~#fff1c9
};

export interface FormationSet {
  count: number;
  positions: Record<FormationId, Float32Array>; // each length count*3
  /** Per formation, count; the path parameter 0..1 (colour gradient + flow phase). */
  params: Record<FormationId, Float32Array>;
  colors: Float32Array; // count*3, from PALETTE by role
  roles: Float32Array; // count; 0 = Opus core, k>=1 = worker stream k-1 (index into lanes)
  delays: Float32Array; // count; uniform random 0..1 (per-particle morph stagger)
  scales: Float32Array; // count; size multiplier 0.5..1.6
  /** count; 0 worker, 1 Opus core, 2 Opus halo (huge faint sprite), 3 bokeh. */
  kinds: Float32Array;
  /** count; along-stream rank u in (0,1), stratified within the particle's group. */
  ranks: Float32Array;
  /** count; stream index k (index into lanes) for workers, -1 for Opus. */
  groups: Int16Array;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const BX = 7;
const BY = 4.5;
const BZ = 4;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Standard-normal sample via Box-Muller (two rng draws). */
function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

type V3 = [number, number, number];
/** Worker baker: stream k of n, along-stream rank u in (0,1), particle index i.
 *  Writes o and returns the path parameter 0..1. Monotonic in u. */
type Bake = (k: number, n: number, u: number, rng: () => number, o: V3, i: number) => number;

const GOLDEN = 2.399963229728653;

function rotX(o: V3, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const y = o[1];
  const z = o[2];
  o[1] = y * c - z * s;
  o[2] = y * s + z * c;
}

function rotY(o: V3, a: number): void {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = o[0];
  const z = o[2];
  o[0] = x * c + z * s;
  o[2] = -x * s + z * c;
}

/** Fibonacci-sphere direction from rank u (m = group size). */
function fib(u: number, m: number, o: V3): V3 {
  const cz = 1 - 2 * u;
  const r = Math.sqrt(Math.max(0, 1 - cz * cz));
  const ph = u * m * GOLDEN;
  o[0] = r * Math.cos(ph);
  o[1] = r * Math.sin(ph);
  o[2] = cz;
  return o;
}

// Disk plane normal after the tilt used by bakeDisk (the shader spins about it).
const DISK_TILT = (55 * Math.PI) / 180;
export const DISK_AXIS: V3 = [0, Math.cos(DISK_TILT), Math.sin(DISK_TILT)];

// Ring: circle in XY, rotated about Y then X; the shader turns it about RING_AXIS.
const RING_RY = -0.32;
const RING_RX = 0.45;
export const RING_AXIS: V3 = (() => {
  const v: V3 = [0, 0, 1];
  rotY(v, RING_RY);
  rotX(v, RING_RX);
  return v;
})();

// Galaxy: arm k is a log spiral (n arms), thick bulge, warped rim, tilted 55deg.
const bakeDisk: Bake = (k, n, u, rng, o) => {
  const r = 0.55 + 4.65 * Math.pow(u, 1.25);
  const s = (r - 0.55) / 4.65;
  const spread = (rng() < 0.18 ? 0.34 : 0.1) + 0.05 * s;
  const th = Math.PI / 2 + (k * TAU) / n + 1.6 * Math.log(r / 0.55) + gauss(rng) * spread;
  const y0 = gauss(rng) * (0.07 + 0.8 * Math.exp(-r * 1.2)) + 0.32 * s * s * Math.sin(th);
  const x = r * Math.cos(th);
  const z0 = r * Math.sin(th);
  o[0] = x;
  o[1] = y0 * Math.cos(DISK_TILT) - z0 * Math.sin(DISK_TILT);
  o[2] = y0 * Math.sin(DISK_TILT) + z0 * Math.cos(DISK_TILT);
  return s;
};

// "Opus plans": ray k leaves the centre at its own angle and lifts out of the
// plane; u warped by a density wave gives nodes every ~1 unit along the ray.
const bakeLattice: Bake = (k, n, u, rng, o) => {
  const m = 5;
  const w = u + (0.7 * Math.sin(TAU * m * u)) / (TAU * m); // monotonic: derivative >= 0.3
  const r = 0.8 + 4.6 * w;
  const ang = Math.PI / 2 + (k * TAU) / n;
  const node = 0.5 - 0.5 * Math.cos(TAU * m * u); // 1 where the density peaks
  const side = gauss(rng) * (0.025 + 0.11 * node * node);
  const zk = 0.28 * Math.sin(k * 2.4 + 0.5);
  o[0] = r * Math.cos(ang) - Math.sin(ang) * side;
  o[1] = (r * Math.sin(ang) + Math.cos(ang) * side) * 0.85;
  o[2] = r * zk + gauss(rng) * 0.04;
  return u;
};

// Fan-out: comet k is a quadratic Bezier from the core to an ellipse rx=6, ry=3.6,
// with a z excursion; the tail is thin, the head wide.
const bakeStreams: Bake = (k, n, u, rng, o) => {
  const phi = Math.PI / 2 + (k * TAU) / n;
  const ex = 6 * Math.cos(phi);
  const ey = 3.6 * Math.sin(phi);
  const el = Math.hypot(ex, ey) || 1;
  const cx = ex * 0.45 + (-ey / el) * 1.4; // control point, bowed sideways
  const cy = ey * 0.45 + (ex / el) * 1.4;
  const t = 0.03 + 0.97 * Math.pow(u, 0.85);
  const mt = 1 - t;
  const sp = 0.03 + 0.2 * t * t;
  const zk = Math.sin(k * 2.4 + 0.7);
  o[0] = 2 * mt * t * cx + t * t * ex + gauss(rng) * sp;
  o[1] = 2 * mt * t * cy + t * t * ey + gauss(rng) * sp;
  o[2] = zk * 1.6 * Math.sin(Math.PI * t) + zk * 0.4 * t + gauss(rng) * sp * 0.6;
  return t;
};

// "Build": tower k is a box column; u = height fraction; depth staggered per tower.
const TOWER_BASE = -2.6;
function bakeTowersFor(heights: number[]): Bake {
  return (k, n, u, rng, o) => {
    const cx = n === 1 ? 0 : -5 + (10 * k) / (n - 1);
    const h = heights[k];
    const zc = ((k % 3) - 1) * 0.8;
    const hw = 0.275;
    const q = rng();
    let x: number;
    let z: number;
    if (q < 0.7) {
      // on the box surface: one of the 4 sides
      const f = rng();
      if (f < 0.35) {
        x = cx + hw;
        z = (rng() * 2 - 1) * hw;
      } else if (f < 0.7) {
        x = cx - hw;
        z = (rng() * 2 - 1) * hw;
      } else if (f < 0.85) {
        x = cx + (rng() * 2 - 1) * hw;
        z = hw;
      } else {
        x = cx + (rng() * 2 - 1) * hw;
        z = -hw;
      }
    } else {
      x = cx + (rng() * 2 - 1) * hw; // inside the box
      z = (rng() * 2 - 1) * hw;
    }
    o[0] = x;
    o[1] = TOWER_BASE + u * h;
    o[2] = zc + z;
    return u;
  };
}

// SwarmKit mark: flat-top hexagon outline (R=3). Perimeter run k covers
// [k/n, (k+1)/n] of the loop; tilted for depth.
const HEX_V: number[] = [];
for (let v = 0; v < 6; v++) HEX_V.push(3 * Math.cos((v * Math.PI) / 3), 3 * Math.sin((v * Math.PI) / 3));
const bakeHex: Bake = (k, n, u, rng, o) => {
  const s = Math.min(5.999, ((k + u) / n) * 6);
  const e = Math.floor(s);
  const f = s - e;
  const ax = HEX_V[(e * 2) % 12];
  const ay = HEX_V[(e * 2 + 1) % 12];
  const bx = HEX_V[((e + 1) * 2) % 12];
  const by = HEX_V[((e + 1) * 2 + 1) % 12];
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.hypot(ex, ey) || 1;
  const off = (rng() + rng() - 1) * 0.2 + gauss(rng) * 0.02; // glowing band, densest on the line
  o[0] = ax + ex * f + (-ey / len) * off;
  o[1] = ay + ey * f + (ex / len) * off;
  o[2] = gauss(rng) * 0.05;
  rotY(o, -0.4);
  rotX(o, 0.35);
  return (k + u) / n;
};

// Halo torus (R=4.6, tube ~0.3); arc k covers [k/n, (k+1)/n]; tilted on two axes.
const bakeRing: Bake = (k, n, u, rng, o) => {
  const th = (((k + u) / n) * TAU) + Math.PI / 2;
  const ph = rng() * TAU;
  const rho = 0.3 * Math.sqrt(rng());
  const rr = 4.6 + rho * Math.cos(ph);
  o[0] = rr * Math.cos(th);
  o[1] = rr * Math.sin(th);
  o[2] = rho * Math.sin(ph);
  rotY(o, RING_RY);
  rotX(o, RING_RX);
  return (k + u) / n;
};

// Three CLI spheres (r=1.2) at x=-4.2/0/4.2: lane k joins cluster k%3 (with fewer
// than three lanes, particle i joins cluster i%3 so all three stay populated).
const TRIO_X = [-4.2, 0, 4.2];
const TRIO_Y = -0.4;
const bakeTrio: Bake = (k, n, u, rng, o, i) => {
  const c = n >= 3 ? k % 3 : i % 3;
  fib(u, 997, o);
  const rr = Math.pow(rng(), 0.42);
  o[0] = TRIO_X[c] + o[0] * rr * 1.2;
  o[1] = TRIO_Y + o[1] * rr * 1.2;
  o[2] = o[2] * rr * 1.2;
  return rr;
};

// Opus: a radiant core in every formation (centre; tower hover point; split
// across the three trio centres). Returns the radial fraction 0..1.
function bakeOpus(id: FormationId, j: number, u: number, m: number, rng: () => number, o: V3): number {
  const R = id === 'towers' ? 0.35 : 0.5;
  fib(u, m, o);
  const rr = Math.pow(rng(), 0.5);
  const cx = id === 'trio' ? TRIO_X[j % 3] : 0;
  const cy = id === 'trio' ? TRIO_Y : id === 'towers' ? 3.4 : 0;
  o[0] = cx + o[0] * rr * R;
  o[1] = cy + o[1] * rr * R;
  o[2] = o[2] * rr * R;
  return rr;
}

export function buildFormations(opts: { count: number; lanes: Lane[]; seed?: number }): FormationSet {
  const { count, lanes } = opts;
  const seed = opts.seed ?? 7;
  const n = Math.max(1, lanes.length);
  const laneOf = (s: number): Lane => (lanes.length ? lanes[s % lanes.length] : 'opencode');
  const opus = Math.ceil(count * 0.06);

  const rng = mulberry32(seed);
  const roles = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  const scales = new Float32Array(count);
  const kinds = new Float32Array(count);
  const ranks = new Float32Array(count);
  const groups = new Int16Array(count);
  // Group sizes: Opus is one group, workers round-robin over n streams.
  const gsize = new Array<number>(n).fill(0);
  for (let i = opus; i < count; i++) gsize[i % n]++;
  const seen = new Array<number>(n).fill(0);
  for (let i = 0; i < count; i++) {
    const role = i < opus ? 0 : (i % n) + 1; // Opus core first, then round-robin streams
    roles[i] = role;
    const c = role === 0 ? PALETTE.opus : PALETTE[laneOf(role - 1)];
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    delays[i] = rng();
    if (role === 0) {
      groups[i] = -1;
      ranks[i] = (i + rng()) / opus; // stratified within the Opus group
      kinds[i] = i % 24 === 0 ? 2 : 1; // a few huge faint halo sprites
      scales[i] = 1 + rng() * 0.5;
    } else {
      const k = role - 1;
      groups[i] = k;
      ranks[i] = (seen[k]++ + rng()) / gsize[k]; // stratified within the stream
      kinds[i] = rng() < 0.012 ? 3 : 0; // rare bokeh discs
      scales[i] = 0.5 + 1.1 * Math.pow(rng(), 4);
    }
  }

  // Per-formation streams: each layout draws the same values for a given seed.
  const stream = (k: number): (() => number) => mulberry32((seed + k * 7919) >>> 0);
  const hrng = stream(7);
  const heights = Array.from({ length: n }, () => 2.2 + hrng() * 2.0); // tower height per stream
  const makers: [FormationId, number, Bake][] = [
    ['disk', 0, bakeDisk],
    ['lattice', 1, bakeLattice],
    ['streams', 2, bakeStreams],
    ['towers', 3, bakeTowersFor(heights)],
    ['hex', 4, bakeHex],
    ['ring', 5, bakeRing],
    ['trio', 6, bakeTrio],
  ];
  const positions = {} as Record<FormationId, Float32Array>;
  const params = {} as Record<FormationId, Float32Array>;
  const o: V3 = [0, 0, 0];
  for (const [id, si, bake] of makers) {
    const arr = new Float32Array(count * 3);
    const par = new Float32Array(count);
    const frng = stream(si);
    for (let i = 0; i < count; i++) {
      par[i] = i < opus
        ? bakeOpus(id, i, ranks[i], opus, frng, o)
        : bake(groups[i], n, ranks[i], frng, o, i);
      // belt-and-braces: never leave the camera frame
      arr[i * 3] = clamp(o[0], -BX, BX);
      arr[i * 3 + 1] = clamp(o[1], -BY, BY);
      arr[i * 3 + 2] = clamp(o[2], -BZ, BZ);
    }
    positions[id] = arr;
    params[id] = par;
  }
  return { count, positions, params, colors, roles, delays, scales, kinds, ranks, groups };
}
