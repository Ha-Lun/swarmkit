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
  colors: Float32Array; // count*3, from PALETTE by role
  roles: Float32Array; // count; 0 = Opus core, k>=1 = worker stream k-1 (index into lanes)
  delays: Float32Array; // count; uniform random 0..1 (per-particle morph stagger)
  scales: Float32Array; // count; size multiplier 0.5..1.6
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

/** Uniform random unit vector. */
function dir3(rng: () => number, out: number[]): number[] {
  const z = rng() * 2 - 1;
  const a = rng() * TAU;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  out[0] = r * Math.cos(a);
  out[1] = r * Math.sin(a);
  out[2] = z;
  return out;
}

function setSphere(
  arr: Float32Array,
  i: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  rng: () => number,
  density: number, // radius exponent: 1/3 = uniform, larger = denser toward centre
): void {
  const d = dir3(rng, [0, 0, 0]);
  const r = radius * Math.pow(rng(), density);
  arr[i * 3] = cx + d[0] * r;
  arr[i * 3 + 1] = cy + d[1] * r;
  arr[i * 3 + 2] = cz + d[2] * r;
}

// Galaxy disk tilted ~60deg around X (reads as an ellipse), 3 log-spiral arms.
function bakeDisk(arr: Float32Array, count: number, opus: number, rng: () => number): void {
  const cosT = Math.cos(Math.PI / 3);
  const sinT = Math.sin(Math.PI / 3);
  for (let i = 0; i < count; i++) {
    if (i < opus) {
      setSphere(arr, i, 0, 0, 0, 0.55, rng, 1 / 3); // dense bright Opus core
      continue;
    }
    const arm = i % 3;
    const r = 0.5 + 5.5 * rng();
    const th = (arm * TAU) / 3 + 2.1 * Math.log(r / 0.5) + gauss(rng) * 0.12;
    const x = r * Math.cos(th);
    const z0 = r * Math.sin(th);
    const y0 = gauss(rng) * 0.15;
    arr[i * 3] = x;
    arr[i * 3 + 1] = (y0 * cosT - z0 * sinT) * 0.8;
    arr[i * 3 + 2] = y0 * sinT + z0 * cosT;
  }
}

// "Opus plans": straight rays from the centre + node clusters + a faint outer ring.
function bakeLattice(arr: Float32Array, count: number, opus: number, n: number, rng: () => number): void {
  for (let i = 0; i < count; i++) {
    if (i < opus) {
      setSphere(arr, i, 0, 0, 0, 0.6, rng, 1 / 3);
      continue;
    }
    const s = i % n;
    const ang = Math.PI / 2 + (s * TAU) / n;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let r: number;
    const u = rng();
    if (u < 0.15) r = 5.2; // faint thin outer circle
    else if (u < 0.55) r = 0.8 + Math.floor(rng() * 5) * 1.0 + gauss(rng) * 0.12; // node clusters every 1.0
    else r = 0.8 + rng() * 4.4; // along the ray
    arr[i * 3] = r * dx + gauss(rng) * 0.03;
    arr[i * 3 + 1] = (r * dy + gauss(rng) * 0.03) * 0.85;
    arr[i * 3 + 2] = gauss(rng) * 0.03;
  }
}

// Fan-out: curved comet paths (quadratic Bezier) to an ellipse rx=6, ry=3.6, head-dense.
function bakeStreams(arr: Float32Array, count: number, opus: number, n: number, rng: () => number): void {
  for (let i = 0; i < count; i++) {
    if (i < opus) {
      setSphere(arr, i, 0, 0, 0, 0.45, rng, 1 / 3);
      continue;
    }
    const s = i % n;
    const phi = Math.PI / 2 + (s * TAU) / n;
    const ex = 6 * Math.cos(phi);
    const ey = 3.6 * Math.sin(phi);
    const el = Math.hypot(ex, ey) || 1;
    const cx = ex * 0.45 + (-ey / el) * 1.2; // control point, bowed sideways
    const cy = ey * 0.45 + (ex / el) * 1.2;
    const t = Math.pow(rng(), 0.45);
    const mt = 1 - t;
    const spread = 0.02 + 0.16 * t;
    arr[i * 3] = 2 * mt * t * cx + t * t * ex + gauss(rng) * spread;
    arr[i * 3 + 1] = 2 * mt * t * cy + t * t * ey + gauss(rng) * spread;
    arr[i * 3 + 2] = gauss(rng) * spread * 0.5;
  }
}

// "Build": N box columns in a row; Opus hovers above the middle.
function bakeTowers(
  arr: Float32Array,
  count: number,
  opus: number,
  n: number,
  rng: () => number,
  heights: number[],
): void {
  for (let i = 0; i < count; i++) {
    if (i < opus) {
      setSphere(arr, i, 0, 3.4, 0, 0.35, rng, 1 / 3);
      continue;
    }
    const s = i % n;
    const cx = n === 1 ? 0 : -5 + (10 * s) / (n - 1);
    const h = heights[s];
    const base = -2.6;
    const y = base + rng() * h;
    const u = rng();
    let x: number;
    let z: number;
    let yy = y;
    if (u < 0.7) {
      // on the box surface: pick one of the 4 sides, or the top
      const f = rng();
      if (f < 0.28) {
        x = cx + 0.275;
        z = (rng() * 2 - 1) * 0.275;
      } else if (f < 0.56) {
        x = cx - 0.275;
        z = (rng() * 2 - 1) * 0.275;
      } else if (f < 0.7) {
        x = cx + (rng() * 2 - 1) * 0.275;
        z = 0.275;
      } else if (f < 0.84) {
        x = cx + (rng() * 2 - 1) * 0.275;
        z = -0.275;
      } else {
        x = cx + (rng() * 2 - 1) * 0.275;
        z = (rng() * 2 - 1) * 0.275;
        yy = base + h;
      }
    } else {
      // inside the box
      x = cx + (rng() * 2 - 1) * 0.275;
      z = (rng() * 2 - 1) * 0.275;
    }
    arr[i * 3] = x;
    arr[i * 3 + 1] = yy;
    arr[i * 3 + 2] = z;
  }
}

// SwarmKit mark: flat-top hexagon outline (R=3, glowing band) + sparse fill.
function bakeHex(arr: Float32Array, count: number, opus: number, rng: () => number): void {
  const V: number[] = [];
  for (let k = 0; k < 6; k++) V.push(3 * Math.cos((k * Math.PI) / 3), 3 * Math.sin((k * Math.PI) / 3));
  for (let i = 0; i < count; i++) {
    if (i < opus) {
      setSphere(arr, i, 0, 0, 0, 0.4, rng, 1 / 3);
      continue;
    }
    const e = Math.floor(rng() * 6);
    if (rng() < 0.12) {
      // sparse interior fill: uniform over the fan triangle (centre, V_e, V_e+1)
      const ax = V[(e * 2) % 12];
      const ay = V[(e * 2 + 1) % 12];
      const bx = V[((e + 1) * 2) % 12];
      const by = V[((e + 1) * 2 + 1) % 12];
      let u = rng();
      let v = rng();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      arr[i * 3] = u * ax + v * bx;
      arr[i * 3 + 1] = u * ay + v * by;
      arr[i * 3 + 2] = gauss(rng) * 0.05;
    } else {
      // glowing edge band: triangular offset, densest at the centre line
      const t = rng();
      const ax = V[(e * 2) % 12];
      const ay = V[(e * 2 + 1) % 12];
      const bx = V[((e + 1) * 2) % 12];
      const by = V[((e + 1) * 2 + 1) % 12];
      const ex = bx - ax;
      const ey = by - ay;
      const len = Math.hypot(ex, ey) || 1;
      const off = (rng() + rng() - 1) * 0.175;
      arr[i * 3] = ax + ex * t + (-ey / len) * off;
      arr[i * 3 + 1] = ay + ey * t + (ex / len) * off;
      arr[i * 3 + 2] = gauss(rng) * 0.05;
    }
  }
}

// Halo torus (R=4.6, tube 0.22) tilted 15deg around X; Opus rides along too.
function bakeRing(arr: Float32Array, count: number, rng: () => number): void {
  const cosT = Math.cos(Math.PI / 12);
  const sinT = Math.sin(Math.PI / 12);
  for (let i = 0; i < count; i++) {
    const th = rng() * TAU;
    const ph = rng() * TAU;
    const rho = 0.22 * Math.sqrt(rng());
    const rr = 4.6 + rho * Math.cos(ph);
    const x = rr * Math.cos(th);
    const y = rr * Math.sin(th);
    const z = rho * Math.sin(ph);
    arr[i * 3] = x;
    arr[i * 3 + 1] = (y * cosT - z * sinT) * 0.94;
    arr[i * 3 + 2] = y * sinT + z * cosT;
  }
}

// Three CLI spheres (r=1.2) at x=-4.2/0/4.2; particle i joins sphere i%3.
function bakeTrio(arr: Float32Array, count: number, rng: () => number): void {
  const CX = [-4.2, 0, 4.2];
  for (let i = 0; i < count; i++) setSphere(arr, i, CX[i % 3], -0.4, 0, 1.2, rng, 0.6);
}

export function buildFormations(opts: { count: number; lanes: Lane[]; seed?: number }): FormationSet {
  const { count, lanes } = opts;
  const seed = opts.seed ?? 7;
  const n = Math.max(1, lanes.length);
  const laneOf = (s: number): Lane => (lanes.length ? lanes[s % lanes.length] : 'opencode');
  const opus = Math.ceil(count * 0.08);

  const rng = mulberry32(seed);
  const roles = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  const delays = new Float32Array(count);
  const scales = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const role = i < opus ? 0 : (i % n) + 1; // Opus core first, then round-robin streams
    roles[i] = role;
    const c = role === 0 ? PALETTE.opus : PALETTE[laneOf(role - 1)];
    colors[i * 3] = c[0];
    colors[i * 3 + 1] = c[1];
    colors[i * 3 + 2] = c[2];
    delays[i] = rng();
    if (role === 0) scales[i] = 1.4 + rng() * 0.2; // bright Opus core
    else scales[i] = rng() < 0.06 ? 1.3 : 0.6 + rng() * 0.5; // mostly 0.6..1.1, a few bright
  }

  // Per-formation streams: each layout draws the same values for a given seed.
  const stream = (k: number): (() => number) => mulberry32((seed + k * 7919) >>> 0);
  const hrng = stream(7);
  const heights = Array.from({ length: n }, () => 2.2 + hrng() * 2.0); // tower height per stream
  const makers: [FormationId, (arr: Float32Array) => void][] = [
    ['disk', (a) => bakeDisk(a, count, opus, stream(0))],
    ['lattice', (a) => bakeLattice(a, count, opus, n, stream(1))],
    ['streams', (a) => bakeStreams(a, count, opus, n, stream(2))],
    ['towers', (a) => bakeTowers(a, count, opus, n, stream(3), heights)],
    ['hex', (a) => bakeHex(a, count, opus, stream(4))],
    ['ring', (a) => bakeRing(a, count, stream(5))],
    ['trio', (a) => bakeTrio(a, count, stream(6))],
  ];
  const positions = {} as Record<FormationId, Float32Array>;
  for (const [id, make] of makers) {
    const arr = new Float32Array(count * 3);
    make(arr);
    for (let j = 0; j < arr.length; j += 3) {
      arr[j] = clamp(arr[j], -BX, BX); // belt-and-braces: never leave the camera frame
      arr[j + 1] = clamp(arr[j + 1], -BY, BY);
      arr[j + 2] = clamp(arr[j + 2], -BZ, BZ);
    }
    positions[id] = arr;
  }
  return { count, positions, colors, roles, delays, scales };
}
