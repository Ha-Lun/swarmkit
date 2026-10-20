// Pure camera / comet / beat timeline for the galaxy flight. No three.js import so it runs under node --test.
// Progress p in 0..1 is the only input; everything below is a function of p (scrub-safe, rewinds exactly).

export type V3 = [number, number, number];

export const T = {
  heroHold: 0.09, // hero copy fades out by ~0.14
  cometIn: [0.10, 0.30],
  dive: [0.30, 0.52],
  core: [0.52, 0.58],
  draw: [0.58, 0.78],
  pulse: [0.78, 0.88],
} as const;

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const ss = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Uniform Catmull-Rom through pts, u in 0..1 (clamped). */
export function spline(pts: readonly V3[], u: number): V3 {
  const n = pts.length - 1;
  const x = clamp01(u) * n;
  const i = Math.min(n - 1, Math.floor(x));
  const t = x - i;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n, i + 2)];
  const out: V3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t
      + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t);
  }
  return out;
}

const CAM_PTS: readonly V3[] = [
  [0, 7.6, 15.2],
  [-2.6, 6.8, 12.4],
  [-7.0, 4.4, 5.6],
  [-4.4, 2.0, 3.6],
  [-1.5, 0.7, 3.4],
  [0, 0.1, 2.9],
];
const COMET_PTS: readonly V3[] = [
  [-36, 16, -30],
  [-18, 8.8, -13],
  [-8.5, 4.2, -3],
  [-3.4, 1.5, 0.6],
  [-1.0, 0.4, 0.4],
  [0, 0, 0],
];
export const cometAt = (u: number): V3 => spline(COMET_PTS, u);
export const camRoute = (u: number): V3 => spline(CAM_PTS, u);

const pow = Math.pow;

/** Comet route parameter: fast streak-in, then it accelerates into the core. */
function cometU(p: number): number {
  if (p <= T.cometIn[0]) return 0;
  if (p < T.cometIn[1]) {
    const x = (p - T.cometIn[0]) / (T.cometIn[1] - T.cometIn[0]);
    return 0.6 * (1 - pow(1 - x, 2.2));
  }
  const x = clamp01((p - T.dive[0]) / (T.dive[1] - T.dive[0]));
  return 0.6 + 0.4 * (x * x * (3 - 2 * x)) ** 0.9;
}
/** Camera route parameter. The camera trails the comet and catches up in the dive. */
function camU(p: number): number {
  const x = clamp01((p - 0.10) / (T.dive[1] - 0.10));
  return x * x * (3 - 2 * x) * 0.6 + x * 0.4;
}

export interface SceneState {
  cam: V3;
  target: V3;
  fov: number;
  roll: number;
  cometU: number;
  cometVis: number; // 0..1
  flash: number; // core flash when the comet lands
  diveEnv: number; // 0..1 fly-through envelope (streaks)
  galaxyGain: number; // galaxy brightness multiplier
  coreGain: number; // bulge dimming once the camera is inside it
  bloom: number; // bloom strength multiplier
  exposure: number; // tone-map exposure (pulled down through the dive so the core stays structured, never flat white)
  draw: number; // constellation draw 0..1
  pulse: number; // approved pulse 0..1 (0 = off)
  spin: number; // scroll-driven extra galaxy rotation (rad)
}

export function sceneState(p: number): SceneState {
  p = clamp01(p);
  const cu = cometU(p);
  const w = camU(p);
  const cam = camRoute(w);
  const comet = cometAt(cu);
  const lookBlend = ss(0.10, 0.22, p);
  const hero: V3 = [0, 3.0 * (1 - ss(0.0, 0.2, p)), 0];
  const target = lerp3(hero, comet, lookBlend * (1 - ss(0.5, 0.53, p)));
  const settle = ss(0.52, 0.6, p);
  const drift = clamp01((p - 0.55) / 0.45);
  cam[0] += (-0.45 + 0.95 * drift) * settle;
  cam[1] += 0.12 * Math.sin(drift * 3.1) * settle;
  cam[2] += (-0.15 - 0.35 * drift) * settle;
  const push = ss(0.28, 0.42, p) - ss(0.42, 0.54, p);
  const band = ss(0.27, 0.36, p) * (1 - ss(0.53, 0.60, p)); // the dive's bright stretch
  return {
    cam,
    target,
    fov: 50 + 24 * push,
    roll: 0.1 * push,
    cometU: cu,
    cometVis: ss(0.09, 0.13, p) * (1 - ss(0.5, 0.53, p)),
    flash: 0.4 * Math.exp(-(((p - 0.515) / 0.025) ** 2)),
    diveEnv: ss(0.16, 0.30, p) * (1 - ss(0.52, 0.60, p)),
    galaxyGain: (1 - 0.78 * ss(0.52, 0.64, p)) * (1 - 0.7 * band),
    coreGain: 1 - 0.85 * ss(0.28, 0.40, p),
    bloom: (1 - 0.18 * ss(0.52, 0.6, p)) * (1 - 0.6 * band),
    exposure: 1 - 0.25 * band,
    draw: clamp01((p - T.draw[0]) / (T.draw[1] - T.draw[0])),
    pulse: clamp01((p - T.pulse[0]) / (T.pulse[1] - T.pulse[0])),
    spin: p * 1.3,
  };
}

/** Opacity envelopes for the DOM beats. */
export const beatOpacity = {
  hero: (p: number): number => 1 - ss(0.07, 0.13, p),
  task: (p: number): number => ss(0.13, 0.17, p) * (1 - ss(0.46, 0.51, p)),
  plan: (p: number): number => ss(0.56, 0.61, p),
  approved: (p: number): number => ss(0.8, 0.84, p),
};
/** Characters of the task shown at progress p. */
export function typedChars(p: number, len: number): number {
  return Math.round(len * clamp01((p - 0.16) / 0.22));
}

// ---- late flight: beats 3-5 (fan-out, build, verify) ---------------------------------------------------------------
// The pinned track's scroll progress P (0..1) is split in three: P in 0..SPLIT drives the legacy beats 0-2 (sceneState
// takes p = P / SPLIT), P in SPLIT..LATE_END drives u = 0..1 below (beats 3-5), and P in LATE_END..1 drives the merge
// beat m = 0..1. (The proportions keep beats 0-5 at the scroll length they had before the merge was added.) After the
// track the close sections scroll over the final pose (P stays 1). Everything is a pure function of (u|m, worker
// index), so it scrubs and rewinds.
export const SPLIT = 0.352;
export const LATE_END = 0.766;
export const legacyP = (P: number): number => clamp01(P / SPLIT);
export const lateU = (P: number): number => clamp01((P - SPLIT) / (LATE_END - SPLIT));
export const mergeM = (P: number): number => clamp01((P - LATE_END) / (1 - LATE_END));

export const L = {
  fan: [0.03, 0.27], // star launches, staggered by launchIndex (stagger share 0.4 of the window)
  bubble: [0.34, 0.41],
  build: [0.38, 0.61], // planet accretion, staggered by buildIndex
  sweep: [0.665, 0.80], // the scan beam crosses every planet once
  fix: [0.83, 0.925], // fixer stars fly out
} as const;

const stag = (win: readonly [number, number], idx: number, n: number, share = 0.45): [number, number] => {
  const len = win[1] - win[0];
  const dur = len * (1 - share);
  const start = win[0] + len * share * (n > 1 ? idx / (n - 1) : 0);
  return [start, start + dur];
};
const easeInOut = (t: number): number => t * t * (3 - 2 * t);
const easeOut = (t: number): number => 1 - (1 - t) ** 2.4;

/** Unwrapped disc angle of star j's rest point (ascending with j, so the scan beam meets the stars in launch order). */
export const destTheta = (j: number, n: number): number => (212 + (n > 1 ? j / (n - 1) : 0.5) * 292) * (Math.PI / 180);
/** Where star j (in launch order of n) comes to rest in the galaxy disc. aspect < 1.2 packs the ring taller than wide. */
export function starDest(j: number, n: number, aspect: number): V3 {
  const wide = aspect >= 1.2;
  const ang = destTheta(j, n);
  const r = [3.4, 5.4, 3.9, 6.0, 3.5, 5.6, 4.2, 6.1][j % 8] * (wide ? 1 : 0.92);
  const xs = wide ? 1 : 0.64;
  const zs = wide ? 1 : 1.3;
  return [Math.cos(ang) * r * xs, 0.12 * Math.sin(j * 2.1), Math.sin(ang) * r * zs];
}

/** Launch progress 0..1 of star j. */
export function launchK(u: number, j: number, n: number): number {
  const [a, b] = stag(L.fan, j, n, 0.4);
  return easeOut(clamp01((u - a) / (b - a)));
}
/** Position on the launch arc from the constellation slot s to the rest point d, k in 0..1. Writes into out. */
export function starAt(out: V3, s: V3, d: V3, j: number, k: number): V3 {
  // quadratic bezier, control lifted over the disc and swung sideways so every launch is a curve, not a line
  const side = j % 2 ? 1 : -1;
  const cx = (s[0] + d[0]) * 0.5 - (d[2] - s[2]) * 0.18 * side;
  const cy = Math.max(s[1], d[1]) + 1.6 + 0.4 * (j % 3);
  const cz = (s[2] + d[2]) * 0.5 + (d[0] - s[0]) * 0.18 * side;
  const m = 1 - k;
  out[0] = m * m * s[0] + 2 * m * k * cx + k * k * d[0];
  out[1] = m * m * s[1] + 2 * m * k * cy + k * k * d[1];
  out[2] = m * m * s[2] + 2 * m * k * cz + k * k * d[2];
  return out;
}
export const bubbleAmt = (u: number, j: number, n: number): number => {
  const [a, b] = stag(L.bubble, j, n, 0.5);
  return easeInOut(clamp01((u - a) / (b - a)));
};
/** Planet accretion 0..1 for the worker with build order bi. */
export const growAmt = (u: number, bi: number, n: number): number => {
  const [a, b] = stag(L.build, bi, n, 0.5);
  return clamp01((u - a) / (b - a));
};
/** Sweep: angle range and the time the beam crosses angle theta. */
export function sweepRange(angles: number[]): [number, number] {
  return [Math.min(...angles) - 0.32, Math.max(...angles) + 0.32];
}
export const sweepAngle = (u: number, a0: number, a1: number): number => a0 + (a1 - a0) * clamp01((u - L.sweep[0]) / (L.sweep[1] - L.sweep[0]));
export const sweepTime = (theta: number, a0: number, a1: number): number => L.sweep[0] + (L.sweep[1] - L.sweep[0]) * clamp01((theta - a0) / (a1 - a0));
/** Fixer flight window for the k-th fixer of nf. */
export function fixWindow(k: number, nf: number): [number, number] {
  return stag(L.fix, k, nf, 0.35);
}
export function fixerAt(out: V3, d: V3, k: number, kk: number): V3 {
  const side = kk % 2 ? -1 : 1;
  const cx = d[0] * 0.5 + d[2] * 0.25 * side;
  const cy = 2.4 + 0.3 * kk;
  const cz = d[2] * 0.5 - d[0] * 0.25 * side;
  const m = 1 - k;
  out[0] = 2 * m * k * cx + k * k * d[0];
  out[1] = 2 * m * k * cy + k * k * d[1];
  out[2] = 2 * m * k * cz + k * k * d[2];
  return out;
}

export interface LateCam { cam: V3; target: V3; fov: number }
const KEYS = (wide: boolean): { u: number; cam: V3; tg: V3; fov: number }[] => wide
  ? [
    { u: 0.0, cam: [0.4, 9.6, 14.2], tg: [-2.7, -0.7, 0.4], fov: 50 },
    { u: 0.27, cam: [0.4, 9.6, 14.2], tg: [-2.7, -0.7, 0.4], fov: 50 },
    { u: 0.6, cam: [-0.6, 7.4, 11.4], tg: [-2.5, -0.6, 0.3], fov: 50 },
    { u: 1.0, cam: [2.0, 7.9, 11.8], tg: [-2.6, -0.6, 0.2], fov: 50 },
  ]
  : [
    { u: 0.0, cam: [0, 16, 19.5], tg: [0, 3.1, 0.2], fov: 50 },
    { u: 0.27, cam: [0, 16, 19.5], tg: [0, 3.1, 0.2], fov: 50 },
    { u: 0.6, cam: [0, 14.2, 17.6], tg: [0, 2.9, 0.2], fov: 50 },
    { u: 1.0, cam: [1.2, 14.4, 17.8], tg: [0, 3.0, 0.2], fov: 50 },
  ];
/** Late camera key pose at u (the caller blends it from the legacy final pose over the first part of the fan-out). */
export function lateCam(u: number, aspect: number): LateCam {
  const k = KEYS(aspect >= 1.2);
  let i = 0;
  while (i < k.length - 2 && u > k[i + 1].u) i++;
  const t = easeInOut(clamp01((u - k[i].u) / (k[i + 1].u - k[i].u)));
  const a = k[i];
  const b = k[i + 1];
  const mix = (x: V3, y: V3): V3 => [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)];
  return { cam: mix(a.cam, b.cam), target: mix(a.tg, b.tg), fov: lerp(a.fov, b.fov, t) };
}

// ---- beat 6: merge (m) -------------------------------------------------------------------------------------------------
export const M = {
  pull: [0.05, 0.6], // planets fall into the core, staggered by merge order (stagger share 0.5 of the window)
  arm: [0.5, 0.9], // the new bright arm grows outward from the core
  cam: [0.42, 0.98], // the camera pulls out to the full galaxy
} as const;

/** Fall progress 0..1 of the planet with merge rank r of n (gravity: it accelerates). */
export function pullK(m: number, r: number, n: number): number {
  const [a, b] = stag(M.pull, r, n, 0.5);
  const x = clamp01((m - a) / (b - a));
  return x ** 2.1;
}
/** Time (m) the planet with merge rank r of n reaches the core. */
export const pullEnd = (r: number, n: number): number => stag(M.pull, r, n, 0.5)[1];
/** Position on the in-spiral from the rest point d to the core, k in 0..1 (writes out). Curved, ends at the core. */
export function mergeAt(out: V3, d: V3, k: number, j: number): V3 {
  const r0 = Math.hypot(d[0], d[2]);
  const a0 = Math.atan2(d[2], d[0]);
  const swirl = 1.15 + 0.12 * (j % 4);
  const a = a0 + swirl * k ** 1.15;
  const r = r0 * (1 - k) ** 0.92;
  out[0] = Math.cos(a) * r;
  out[1] = d[1] * (1 - k) + 0.7 * Math.sin(Math.PI * k) * (j % 2 ? 1 : -0.6) * (1 - 0.4 * k);
  out[2] = Math.sin(a) * r;
  return out;
}
/** Core flare 0..1 (saturating): a short swell before each arrival, an exponential decay after it. Never reaches 1. */
export function coreFlare(m: number, n: number): number {
  let sum = 0;
  for (let r = 0; r < n; r++) {
    const t = m - pullEnd(r, n);
    sum += t < 0 ? 0.55 * Math.exp(-((t / 0.014) ** 2)) : 0.55 * Math.exp(-t / 0.055);
  }
  return 1 - Math.exp(-sum * 1.1);
}
/** Growth of the new arm, 0 (not there) .. 1 (full). */
export const armGrow = (m: number): number => ss(M.arm[0], M.arm[1], m);

const MERGE_KEYS = (wide: boolean): { m: number; cam: V3; tg: V3 }[] => wide
  ? [
    { m: 0.0, cam: lateCam(1, 1.6).cam, tg: lateCam(1, 1.6).target },
    { m: 0.42, cam: [-0.6, 8.2, 12.6], tg: [-3.9, -0.4, 0.2] },
    { m: 1.0, cam: [0.4, 14.0, 20.0], tg: [-5.6, -0.4, 0.0] },
  ]
  : [
    { m: 0.0, cam: lateCam(1, 0.46).cam, tg: lateCam(1, 0.46).target },
    { m: 0.42, cam: [0, 12.5, 15.5], tg: [0, 2.2, 0.2] },
    { m: 1.0, cam: [0, 33, 20], tg: [0, -0.5, 0.0] },
  ];
/** Merge camera at m: starts on the final verify pose, leans in while the planets fall, then pulls out to the whole galaxy. */
export function mergeCam(m: number, aspect: number): LateCam {
  const k = MERGE_KEYS(aspect >= 1.2);
  let i = 0;
  while (i < k.length - 2 && m > k[i + 1].m) i++;
  const t = easeInOut(clamp01((m - k[i].m) / (k[i + 1].m - k[i].m)));
  const a = k[i];
  const b = k[i + 1];
  const mix = (x: V3, y: V3): V3 => [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)];
  return { cam: mix(a.cam, b.cam), target: mix(a.tg, b.tg), fov: 50 };
}

/** Copy envelope for the merge beat (and the fade-out of the verify copy). */
export const mergeOpacity = {
  verifyOut: (m: number): number => 1 - ss(0.0, 0.07, m),
  copy: (m: number): number => ss(0.06, 0.12, m) * (1 - ss(0.84, 0.93, m)),
};

/** Copy envelopes for beats 3-5 (u) and the fade-out of the plan copy. */
export const lateOpacity = {
  planOut: (u: number): number => 1 - ss(0.0, 0.05, u),
  fan: (u: number): number => ss(0.045, 0.09, u) * (1 - ss(0.315, 0.355, u)),
  build: (u: number): number => ss(0.355, 0.40, u) * (1 - ss(0.635, 0.675, u)),
  verify: (u: number): number => ss(0.675, 0.72, u),
};

/** Poses used by the reduced-motion static compositions (page progress P). */
export const STATIC_POSE = {
  galaxy: 0.02 * SPLIT,
  core: 0.55 * SPLIT,
  constellation: 0.92 * SPLIT,
  fan: SPLIT + 0.3 * (LATE_END - SPLIT),
  build: SPLIT + 0.62 * (LATE_END - SPLIT),
  verify: LATE_END,
  merge: LATE_END + 0.5 * (1 - LATE_END),
  close: 1,
} as const;
