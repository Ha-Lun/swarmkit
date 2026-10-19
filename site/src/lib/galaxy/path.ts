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

export const CAM_PTS: readonly V3[] = [
  [0, 7.6, 15.2],
  [-2.6, 6.8, 12.4],
  [-7.0, 4.4, 5.6],
  [-4.4, 2.0, 3.6],
  [-1.5, 0.7, 3.4],
  [0, 0.1, 2.9],
];
export const COMET_PTS: readonly V3[] = [
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
export function cometU(p: number): number {
  if (p <= T.cometIn[0]) return 0;
  if (p < T.cometIn[1]) {
    const x = (p - T.cometIn[0]) / (T.cometIn[1] - T.cometIn[0]);
    return 0.6 * (1 - pow(1 - x, 2.2));
  }
  const x = clamp01((p - T.dive[0]) / (T.dive[1] - T.dive[0]));
  return 0.6 + 0.4 * (x * x * (3 - 2 * x)) ** 0.9;
}
/** Camera route parameter. The camera trails the comet and catches up in the dive. */
export function camU(p: number): number {
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
  const hero: V3 = [0, 2.1 * (1 - ss(0.0, 0.2, p)), 0];
  const target = lerp3(hero, comet, lookBlend * (1 - ss(0.5, 0.53, p)));
  const settle = ss(0.52, 0.6, p);
  const drift = clamp01((p - 0.55) / 0.45);
  cam[0] += (-0.45 + 0.95 * drift) * settle;
  cam[1] += 0.12 * Math.sin(drift * 3.1) * settle;
  cam[2] += (-0.15 - 0.35 * drift) * settle;
  const push = ss(0.28, 0.42, p) - ss(0.42, 0.54, p);
  return {
    cam,
    target,
    fov: 50 + 24 * push,
    roll: 0.1 * push,
    cometU: cu,
    cometVis: ss(0.09, 0.13, p) * (1 - ss(0.5, 0.53, p)),
    flash: Math.exp(-(((p - 0.515) / 0.025) ** 2)),
    diveEnv: ss(0.16, 0.30, p) * (1 - ss(0.5, 0.56, p)),
    galaxyGain: 1 - 0.35 * ss(0.56, 0.66, p),
    coreGain: 1 - 0.55 * ss(0.30, 0.52, p),
    bloom: 1 - 0.18 * ss(0.52, 0.6, p),
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

/** Poses used by the reduced-motion static compositions. */
export const STATIC_POSE = { galaxy: 0.02, core: 0.55, constellation: 0.92 } as const;
