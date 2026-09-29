import { Vector3 } from 'three';
import type { Lattice } from './honeycomb';
import { motion } from './motion-config';

// One continuous camera for the whole site: the camera ORBITS a still globe (origin, core cell on +Z, moon to +X).
//  - ONE position curve: a natural cubic spline (C2) through evenly spaced control points, so every chapter boundary is
//    smooth in velocity AND acceleration. Control points sit at u = index / (N-1); each chapter's [t0,t1] lands on point indices.
//  - ONE look-at curve: piecewise keyframes, continuous at every boundary, then smoothed with a Gaussian in progress, so the target
//    never stops or restarts at a chapter edge (the old per-chapter smoothstep did).
//  - ONE scroll mapping: scroll distance -> arc length with a speed profile that blends smoothly from chapter to chapter, so the
//    camera's speed per scroll changes gradually where the runways change (100/300/300/150/400vh) instead of jumping.
// Everything is in multiples of L, the globe radius, so the path follows the globe if its size changes.
// Points are written as orbit(azimuth deg from the core, elevation deg, distance in L).

export type ChapterName = 'intro' | 'hive' | 'cells' | 'proof' | 'finale';
export interface ChapterSegment {
  chapter: number;
  name: ChapterName;
  t0: number;
  t1: number;
}

export interface CameraPath {
  segments: ChapterSegment[];
  /** writes camera position and look-at target for the curve parameter g in [0,1] (chapter boundaries sit at SEGMENTS[i].t0/t1) */
  sample(globalProgress: number, pos: Vector3, target: Vector3): void;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const RAD = Math.PI / 180;
const orbit = (az: number, el: number, r: number) =>
  v(r * Math.cos(el * RAD) * Math.sin(az * RAD), r * Math.sin(el * RAD), r * Math.cos(el * RAD) * Math.cos(az * RAD));

// Moon centre in units of L; filled in by createCameraPath from the layout.
const MOON = v(0, 0, 0);
const CORE_TOP = v(0, 0.02, 1.06);
// hive framing: between the globe and its moon so both sit in frame
const HIVE_LOOK = v(0.22, 0, 0);
// the fly-over starts looking at the front-left of the globe
const CELLS_LOOK = v(-0.35, 0.05, 0.9);
// proof/finale look slightly to the moon-free side so the moon leaves the frame
const PROOF_LOOK = v(-0.15, -0.05, 0);

// point index ranges: intro 0-3, hive 3-8, cells 8-14, proof 14-18, finale 18-20 (N=21)
const N_INTERVALS = 20;
const at = (i: number) => i / N_INTERVALS;

export const SEGMENTS: ChapterSegment[] = [
  { chapter: 0, name: 'intro', t0: at(0), t1: at(3) },
  { chapter: 1, name: 'hive', t0: at(3), t1: at(8) },
  { chapter: 2, name: 'cells', t0: at(8), t1: at(14) },
  { chapter: 3, name: 'proof', t0: at(14), t1: at(18) },
  { chapter: 4, name: 'finale', t0: at(18), t1: at(20) },
];

export function chapterAt(globalProgress: number): { chapter: number; chapterProgress: number } {
  const g = Math.min(1, Math.max(0, globalProgress));
  for (const s of SEGMENTS) {
    if (g <= s.t1 || s.chapter === SEGMENTS.length - 1) {
      return { chapter: s.chapter, chapterProgress: Math.min(1, Math.max(0, (g - s.t0) / (s.t1 - s.t0))) };
    }
  }
  return { chapter: 0, chapterProgress: 0 };
}

// ---- natural cubic spline (C2), non-uniform knots ----
interface Spline { at(x: number): number; d(x: number): number }
function natural(xs: number[], ys: number[]): Spline {
  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const m = new Array<number>(n).fill(0); // second derivatives
  if (n > 2) {
    const a = new Array<number>(n).fill(0), b = new Array<number>(n).fill(1), c = new Array<number>(n).fill(0), r = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      a[i] = h[i - 1]; b[i] = 2 * (h[i - 1] + h[i]); c[i] = h[i];
      r[i] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]);
    }
    for (let i = 1; i < n; i++) { const w = a[i] / b[i - 1]; b[i] -= w * c[i - 1]; r[i] -= w * r[i - 1]; }
    m[n - 1] = r[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) m[i] = (r[i] - c[i] * m[i + 1]) / b[i];
    m[0] = 0; m[n - 1] = 0;
  }
  const seg = (x: number) => { let i = 0; while (i < n - 2 && x > xs[i + 1]) i++; return i; };
  return {
    at(x) {
      const i = seg(x), hh = h[i], A = (xs[i + 1] - x) / hh, B = (x - xs[i]) / hh;
      return A * ys[i] + B * ys[i + 1] + (((A * A * A - A) * m[i] + (B * B * B - B) * m[i + 1]) * hh * hh) / 6;
    },
    d(x) {
      const i = seg(x), hh = h[i], A = (xs[i + 1] - x) / hh, B = (x - xs[i]) / hh;
      return (ys[i + 1] - ys[i]) / hh + ((-(3 * A * A - 1) * m[i] + (3 * B * B - 1) * m[i + 1]) * hh) / 6;
    },
  };
}

/** Control points of the camera curve in units of L (the same for every globe size). */
const UNIT_POINTS = [
  // 0 intro: close to the core cell, then pull back so every growing ring is in frame
  orbit(4, 17, 2.0), orbit(8, 19, 2.7), orbit(12, 20, 3.35), orbit(14, 21, 3.85),
  // 3 hive: the whole globe and its moon in frame, a slow drift round to the core-facing side (the spacing shrinks gradually
  // from the intro pull-back, so the spline does not loop where the camera slows down)
  orbit(13, 21, 4.05), orbit(10, 21.4, 4.15), orbit(5, 22, 4.2), orbit(0, 22, 4.2), orbit(-5, 22, 4.15),
  // 8 cells: descend to a fly-over across the front hemisphere (pulled back and up, so the horizon curve stays in frame), end beside the moon
  orbit(-45, 34, 3.4), orbit(-62, 29, 3.0), orbit(-32, 24, 2.9), orbit(6, 22, 2.9),
  orbit(24, 25, 3.0), orbit(34, 27, 3.2),
  // 14 proof: the path turns back from the moon side by rising and going over the top (a hairpin at the end of the fly-over
  // gave the spline a sharp corner), then recedes to a wide, dim view from the side away from the moon
  orbit(33, 32, 3.4), orbit(18, 38, 3.75), orbit(-6, 38, 4.05), orbit(-34, 34, 4.4),
  // 18 finale (stub): slow drift
  orbit(-40, 34, 4.5), orbit(-48, 34, 4.6),
];
if (UNIT_POINTS.length !== N_INTERVALS + 1) throw new Error('camera-path: point count must match SEGMENTS');
const KNOTS = UNIT_POINTS.map((_, i) => i);
const SPL = [0, 1, 2].map((k) => natural(KNOTS, UNIT_POINTS.map((p) => p.getComponent(k))));
const unitPos = (g: number, out: Vector3) => out.set(SPL[0].at(g * N_INTERVALS), SPL[1].at(g * N_INTERVALS), SPL[2].at(g * N_INTERVALS));
const unitSpeed = (g: number) => Math.hypot(SPL[0].d(g * N_INTERVALS), SPL[1].d(g * N_INTERVALS), SPL[2].d(g * N_INTERVALS)) * N_INTERVALS; // |dp/dg|

// arc length s(g), a C1 Hermite table (the slope is the exact |dp/dg|), and its inverse by bisection
const ARC_N = 1024;
const arcG: number[] = [], arcS: number[] = [], arcD: number[] = [];
{
  let acc = 0;
  for (let i = 0; i <= ARC_N; i++) {
    const g = i / ARC_N;
    if (i) {
      // Simpson-like: integrate |p'| with the speed at the two ends and the middle
      acc += ((unitSpeed(g - 0.5 / ARC_N) * 4 + unitSpeed(g) + unitSpeed(g - 1 / ARC_N)) / 6) / ARC_N;
    }
    arcG.push(g); arcS.push(acc); arcD.push(unitSpeed(g));
  }
}
const ARC_TOTAL = arcS[ARC_N];
function arcOf(g: number): number {
  const x = Math.min(1, Math.max(0, g)) * ARC_N;
  const i = Math.min(ARC_N - 1, Math.floor(x)), t = x - i, h = 1 / ARC_N;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * arcS[i] + (t3 - 2 * t2 + t) * h * arcD[i] + (-2 * t3 + 3 * t2) * arcS[i + 1] + (t3 - t2) * h * arcD[i + 1];
}
function gOfArc(s: number): number {
  let lo = 0, hi = 1;
  const x = Math.min(ARC_TOTAL, Math.max(0, s));
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (arcOf(mid) < x) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// scroll distance (vh) -> arc length. Each chapter has a mean camera speed (arc length per vh) that makes it end exactly on its
// control point; the speed profile blends smoothly between neighbouring chapters (smoothstep across a window on each side of
// the boundary), so speed and its slope are continuous at every boundary. The chapter means are solved so the blended profile
// still integrates to each chapter's arc length.
const RUNWAY = [motion.runway.intro, motion.runway.hive, motion.runway.cells, motion.runway.proof, motion.runway.finale];
const SCROLL_AT: number[] = [0];
RUNWAY.forEach((r) => SCROLL_AT.push(SCROLL_AT[SCROLL_AT.length - 1] + r));
const SCROLL_TOTAL = SCROLL_AT[SCROLL_AT.length - 1];
const BLEND = [0, 1, 2, 3].map((b) => 0.5 * Math.min(RUNWAY[b], RUNWAY[b + 1])); // half-window at boundary b+1, in vh
const ARC_AT_BOUNDARY = [...SEGMENTS.map((s) => arcOf(s.t0)), arcOf(1)];
const smoothstep = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
// The camera settles into the hex dissolve: it slows to a fraction of its speed across the dissolve window (motion.proof.fromVh..toVh
// around the cells|proof boundary), easing in over 40vh centred on its start and out over 60vh ending 40vh after its end. Smooth (C1).
const SETTLE_AT = SCROLL_AT[3]; // the cells|proof boundary
const SETTLE_IN = SETTLE_AT + motion.proof.fromVh - 20, SETTLE_OUT = SETTLE_AT + motion.proof.toVh - 20;
const settle = (S: number) => 1 - 0.65 * smoothstep((S - SETTLE_IN) / 40) * (1 - smoothstep((S - SETTLE_OUT) / 60));
/** weight of each chapter's mean speed at scroll position S (they sum to 1) */
function speedWeights(S: number, out: number[]): number[] {
  out.fill(0);
  let i = 0;
  while (i < RUNWAY.length - 1 && S >= SCROLL_AT[i + 1]) i++;
  out[i] = 1;
  if (i > 0 && S < SCROLL_AT[i] + BLEND[i - 1]) { // just after boundary i: mixing with the previous chapter
    const t = smoothstep(0.5 + (S - SCROLL_AT[i]) / (2 * BLEND[i - 1]));
    out[i - 1] = 1 - t; out[i] = t;
  } else if (i < RUNWAY.length - 1 && S > SCROLL_AT[i + 1] - BLEND[i]) { // just before boundary i+1
    const t = smoothstep((S - (SCROLL_AT[i + 1] - BLEND[i])) / (2 * BLEND[i]));
    out[i] = 1 - t; out[i + 1] = t;
  }
  return out;
}
const SPEED_MEAN = (() => {
  const n = RUNWAY.length, A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const w = new Array<number>(n).fill(0), STEPS = 4000;
  for (let k = 0; k < STEPS; k++) {
    const S = ((k + 0.5) / STEPS) * SCROLL_TOTAL;
    speedWeights(S, w);
    let ch = 0;
    while (ch < n - 1 && S >= SCROLL_AT[ch + 1]) ch++;
    for (let j = 0; j < n; j++) A[ch][j] += (w[j] * settle(S) * SCROLL_TOTAL) / STEPS;
  }
  const b = ARC_AT_BOUNDARY.slice(1).map((s, i) => s - ARC_AT_BOUNDARY[i]);
  for (let c = 0; c < n; c++) { // Gaussian elimination with partial pivoting
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / A[c][c]; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  const m = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let x = b[r]; for (let k = r + 1; k < n; k++) x -= A[r][k] * m[k]; m[r] = x / A[r][r]; }
  return m;
})();
// cumulative arc length at evenly spaced scroll positions (trapezoid), read back with a cubic Hermite (slope = the speed itself)
const SCROLL_N = 2500;
const SCROLL_S: number[] = [0], SCROLL_V: number[] = [];
{
  const w = new Array<number>(RUNWAY.length).fill(0);
  const speed = (S: number) => settle(S) * speedWeights(S, w).reduce((a, x, j) => a + x * SPEED_MEAN[j], 0);
  for (let i = 0; i <= SCROLL_N; i++) {
    const S = (i / SCROLL_N) * SCROLL_TOTAL;
    SCROLL_V.push(speed(S));
    if (i) SCROLL_S.push(SCROLL_S[i - 1] + ((SCROLL_V[i - 1] + SCROLL_V[i]) / 2) * (SCROLL_TOTAL / SCROLL_N));
  }
}
function scrollArcAt(S: number): number {
  const x = (Math.min(SCROLL_TOTAL, Math.max(0, S)) / SCROLL_TOTAL) * SCROLL_N;
  const i = Math.min(SCROLL_N - 1, Math.floor(x)), t = x - i, h = SCROLL_TOTAL / SCROLL_N;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * SCROLL_S[i] + (t3 - 2 * t2 + t) * h * SCROLL_V[i] + (-2 * t3 + 3 * t2) * SCROLL_S[i + 1] + (t3 - t2) * h * SCROLL_V[i + 1];
}

/**
 * Camera curve parameter for a point in the scroll: chapter index and chapter progress (what scroll.ts writes).
 * Chapter boundaries still land on SEGMENTS[i].t0/t1, but between them the camera speed per scroll varies smoothly instead of
 * jumping where the runways change.
 */
export function scrollToProgress(chapter: number, chapterProgress: number): number {
  const S = SCROLL_AT[chapter] + Math.min(1, Math.max(0, chapterProgress)) * RUNWAY[chapter];
  return gOfArc(scrollArcAt(S));
}

/**
 * The inverse of scrollToProgress: the chapter and chapter progress whose camera parameter is `g`. The walk is driven by the world's damped
 * progress (the same input as the camera), so it reads its chapter progress back from g instead of from the raw scroll state.
 */
export function progressOfG(g: number): { chapter: number; chapterProgress: number } {
  const target = arcOf(Math.min(1, Math.max(0, g)));
  let lo = 0, hi = SCROLL_TOTAL;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (scrollArcAt(mid) < target) lo = mid; else hi = mid; }
  const S = (lo + hi) / 2;
  let ch = 0;
  while (ch < RUNWAY.length - 1 && S >= SCROLL_AT[ch + 1]) ch++;
  return { chapter: ch, chapterProgress: Math.min(1, Math.max(0, (S - SCROLL_AT[ch]) / RUNWAY[ch])) };
}

export function createCameraPath(lattice: Lattice): CameraPath {
  const L = lattice.radius;
  MOON.copy(lattice.moon.centre).multiplyScalar(1 / L);

  // look-at: keyframes continuous across every chapter boundary
  const keys: [number, Vector3][] = [
    [at(0), CORE_TOP], [at(3), HIVE_LOOK], [at(8), HIVE_LOOK], [at(9.5), CELLS_LOOK], [at(11), CELLS_LOOK],
    [at(14), MOON], [at(18), PROOF_LOOK], [at(20), PROOF_LOOK],
  ];
  const ss = (t: number) => t * t * (3 - 2 * t);
  const cl = (t: number) => Math.min(1, Math.max(0, t));
  const rawLook = (g: number, out: Vector3) => {
    let i = 0;
    while (i < keys.length - 2 && g > keys[i + 1][0]) i++;
    const [g0, a] = keys[i], [g1, b] = keys[i + 1];
    out.lerpVectors(a, b, cl((g - g0) / (g1 - g0))); // linear between keys; the smoothing below rounds every corner
    if (g > at(8) && g < at(14)) {
      // fly-over: in mid-chapter the target is the globe surface a little way along the path
      const w = ss(cl((g - at(9)) / at(1.5))) * (1 - ss(cl((g - at(10.5)) / at(1.5))));
      const ahead = unitPos(Math.min(1, g + 0.06), new Vector3()).setLength(0.3);
      out.lerp(ahead, w * 0.75);
    }
    return out;
  };
  // Gaussian smoothing in progress: removes the corner at every key, so the target moves as one continuous curve
  const M = 2048, SIGMA = 0.026 * M;
  const raw: Vector3[] = Array.from({ length: M + 1 }, (_, i) => rawLook(i / M, new Vector3()));
  const rad = Math.ceil(3.2 * SIGMA);
  const kern = Array.from({ length: 2 * rad + 1 }, (_, k) => Math.exp(-0.5 * ((k - rad) / SIGMA) ** 2));
  const ksum = kern.reduce((a, b) => a + b, 0);
  const look: Vector3[] = raw.map((_, i) => {
    const o = new Vector3();
    for (let k = -rad; k <= rad; k++) o.addScaledVector(raw[Math.min(M, Math.max(0, i + k))], kern[k + rad] / ksum);
    return o;
  });
  const lookSample = (g: number, out: Vector3) => {
    // cubic Hermite through the table with central-difference slopes (C1)
    const x = cl(g) * M, i = Math.min(M - 1, Math.floor(x)), t = x - i;
    const p0 = look[i], p1 = look[i + 1], m0 = look[Math.min(M, i + 1)].clone().sub(look[Math.max(0, i - 1)]).multiplyScalar(0.5), m1 = look[Math.min(M, i + 2)].clone().sub(look[i]).multiplyScalar(0.5);
    const t2 = t * t, t3 = t2 * t;
    return out.copy(p0).multiplyScalar(2 * t3 - 3 * t2 + 1).addScaledVector(m0, t3 - 2 * t2 + t).addScaledVector(p1, -2 * t3 + 3 * t2).addScaledVector(m1, t3 - t2).multiplyScalar(L);
  };

  return {
    segments: SEGMENTS,
    sample(globalProgress, pos, target) {
      const g = cl(globalProgress);
      unitPos(g, pos).multiplyScalar(L);
      lookSample(g, target);
    },
  };
}
