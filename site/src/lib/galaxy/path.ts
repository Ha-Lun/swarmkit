// Pure camera / comet / beat timeline for the galaxy flight. No three.js import so it runs under node --test.
// Progress p in 0..1 is the only input; everything below is a function of p (scrub-safe, rewinds exactly).

export type V3 = [number, number, number];

export const T = {
  heroHold: 0.09, // hero copy fades out by ~0.14
  cometIn: [0.10, 0.30],
  dive: [0.30, 0.52],
  core: [0.52, 0.58],
  draw: [0.60, 0.80], // orbit rings draw in, one per planet
  pulse: [0.84, 0.95], // the subtle "approved" ring from the sun
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
  diveEnv: number; // 0..1 fly-through envelope (parallax)
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
// beat m = 0..1. After the track the close sections scroll over the final pose (P stays 1). Everything is a pure
// function of (u|m, planet), so it scrubs and rewinds.
export const SPLIT = 0.352;
export const LATE_END = 0.766;
export const legacyP = (P: number): number => clamp01(P / SPLIT);
export const lateU = (P: number): number => clamp01((P - SPLIT) / (LATE_END - SPLIT));
export const mergeM = (P: number): number => clamp01((P - LATE_END) / (1 - LATE_END));
/** Orbital clock for the planets: scroll-driven (no autoplay), 0 until the late beats start. */
export const orbitT = (P: number): number => 4.2 * clamp01((P - SPLIT) / (1 - SPLIT));

export const L = {
  fan: [0.03, 0.27], // planets launch from the sun, staggered by launch order
  build: [0.36, 0.61], // worktree rings grow, staggered by build order
  scan: [0.665, 0.745], // the verify wave runs out ring by ring
  tick: 0.03, // u a planet takes to run through its verify flash after the arc passes
  fly: [0.79, 0.84], // the camera flies in to the close-up planet
  dwell: [0.84, 0.955], // close-up hold; c = 0..1 drives the planet's flashes and its fixer
  out: [0.955, 1.0], // and pulls back to the overview
  ship: [0.8, 0.918], // the fixer's flight from outside the system; it docks at the end
} as const;
/** Close-up progress c 0..1 (flashPhase input for the close-up planet). */
export const closeC = (u: number): number => clamp01((u - L.dwell[0]) / (L.dwell[1] - L.dwell[0]));
/** Camera blend toward the close-up planet, 0 (overview) .. 1. */
export const closeAmt = (u: number): number => ss(L.fly[0], L.fly[1], u) * (1 - ss(L.out[0], L.out[1], u));
/** Fixer flight progress 0..1 (1 = docked). */
export const shipK = (u: number): number => clamp01((u - L.ship[0]) / (L.ship[1] - L.ship[0]));
/** u as a 0..1 window position. */
export const win = (w: readonly [number, number], u: number): number => clamp01((u - w[0]) / (w[1] - w[0]));

// ---- the verify wave: light leaves the sun and reaches the orbits one after another (inner ring first) --------------
/** Wave front in ring-rank space: 0 at the start of L.scan, n at its end, ring `rank` is hit at rank + 0.5. Keeps growing past the window so late flashes finish (>= 0, monotonic). */
export const waveF = (u: number, n: number): number => Math.max(0, ((u - L.scan[0]) / (L.scan[1] - L.scan[0])) * n);
/** The front's world radius: 0 at the start of L.scan, the outer ring by its end, never beyond it. `radii` ascending. */
export function waveR(u: number, radii: readonly number[]): number {
  const n = radii.length;
  if (n === 0) return 0;
  const x = Math.min(waveF(u, n), n - 0.5); // ring i sits at rank-space i + 0.5
  if (x <= 0.5) return radii[0] * (x / 0.5);
  const i = Math.min(n - 2, Math.floor(x - 0.5));
  if (i < 0) return radii[0];
  const f = x - 0.5 - i;
  return radii[i] + (radii[i + 1] - radii[i]) * f;
}
/** A planet's verify progress (flashPhase input): starts when the wave reaches its ring (rank by radius, inner first), runs for L.tick. */
export const verifyU = (u: number, rank: number, n: number): number => {
  const hit = L.scan[0] + ((rank + 0.5) / Math.max(1, n)) * (L.scan[1] - L.scan[0]);
  return clamp01((u - hit) / L.tick);
};
const easeInOut = (t: number): number => t * t * (3 - 2 * t);

export interface LateCam { cam: V3; target: V3; fov: number }
const TAN25 = Math.tan((25 * Math.PI) / 180);
/** A camera that sees `focus` from (dist, elev, az) with the focus placed at NDC (offX, offY) on screen. */
export function viewPose(focus: V3, dist: number, elev: number, az: number, offX: number, offY: number, aspect: number): LateCam {
  const dir: V3 = [Math.sin(az) * Math.cos(elev), Math.sin(elev), Math.cos(az) * Math.cos(elev)];
  // forward = -dir; right = normalize(forward x up) = (dir.z, 0, -dir.x); up' = right x forward
  const rl = Math.hypot(dir[2], dir[0]) || 1;
  const right: V3 = [dir[2] / rl, 0, -dir[0] / rl];
  const fwd: V3 = [-dir[0], -dir[1], -dir[2]];
  const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  const hh = dist * TAN25;
  const hw = hh * aspect;
  const target: V3 = [0, 1, 2].map((k) => focus[k] - right[k] * offX * hw - up[k] * offY * hh) as V3;
  const cam: V3 = [0, 1, 2].map((k) => target[k] + dir[k] * dist) as V3;
  return { cam, target, fov: 50 };
}

/** The system overview: the sun sits right of the copy column on wide screens, below the copy on portrait. */
export function systemView(aspect: number, rMax: number, zoom = 1): LateCam {
  const wide = aspect >= 1.2;
  const fill = wide ? 0.54 : 0.9;
  const dist = Math.max(rMax / (fill * TAN25 * aspect), wide ? 11 : 12) * zoom;
  if (wide) return viewPose([0, 0, 0], dist, 0.49, 0, 0.33 + Math.max(0, 1.6 - aspect) * 0.25, -0.02, aspect);
  return viewPose([0, 0, 0], dist, 0.7, 0, 0, -0.3, aspect);
}
/** Close-up on a planet at `pos` (angle `ang` about the sun): from the tangent side so the sun glows far behind it. */
export function closeView(pos: V3, aspect: number): LateCam {
  const ang = Math.atan2(pos[2], pos[0]);
  const hx = -Math.sin(ang) * 0.82 + Math.cos(ang) * 0.57; // tangent plus a little outward
  const hz = Math.cos(ang) * 0.82 + Math.sin(ang) * 0.57;
  const wide = aspect >= 1.2;
  return viewPose(pos, wide ? 1.9 : 1.75, 0.34, Math.atan2(hx, hz), wide ? 0.3 : 0, wide ? -0.02 : -0.36, aspect);
}

// ---- beat 5: merge (m) -------------------------------------------------------------------------------------------------
export const M = {
  pull: [0.05, 0.6], // planets fall into the sun, staggered by merge order (stagger share 0.5 of the window)
  burst: [0.58, 0.68], // the sun swells and bursts: white flash plus one expanding shock ring; the system is gone by the end
  form: [0.6, 0.95], // the debris flies out from the core and swirls into the spiral galaxy
} as const;

const stag = (win: readonly [number, number], idx: number, n: number, share = 0.45): [number, number] => {
  const len = win[1] - win[0];
  const dur = len * (1 - share);
  const start = win[0] + len * share * (n > 1 ? idx / (n - 1) : 0);
  return [start, start + dur];
};
/** Fall progress 0..1 of the planet with merge rank r of n (gravity: it accelerates). */
export function pullK(m: number, r: number, n: number): number {
  const [a, b] = stag(M.pull, r, n, 0.5);
  const x = clamp01((m - a) / (b - a));
  return x ** 2.1;
}
/** Time (m) the planet with merge rank r of n reaches the sun. */
export const pullEnd = (r: number, n: number): number => stag(M.pull, r, n, 0.5)[1];
/** Sun flare 0..1 (saturating): a short swell before each arrival, an exponential decay after it. Never reaches 1. */
export function coreFlare(m: number, n: number): number {
  let sum = 0;
  for (let r = 0; r < n; r++) {
    const t = m - pullEnd(r, n);
    sum += t < 0 ? 0.55 * Math.exp(-((t / 0.014) ** 2)) : 0.55 * Math.exp(-t / 0.055);
  }
  return 1 - Math.exp(-sum * 1.1);
}
/** Galaxy formation 0 (everything at the core) .. 1 (every star on its final arm). Monotonic. */
export const formK = (m: number): number => 1 - (1 - clamp01((m - M.form[0]) / (M.form[1] - M.form[0]))) ** 1.7; // explosive start (thrown out), soft landing
/** Sun swell 0..1 before the burst (the star bloats as the last planets arrive). */
export const sunSwell = (m: number): number => ss(0.3, M.burst[0], m) * (1 - ss(M.burst[0], M.burst[0] + 0.03, m));
/** The system (sun, glow pool, orbit ribbons) is present 1 .. gone 0 across the burst. */
export const systemLeft = (m: number): number => 1 - ss(M.burst[0] + 0.01, M.burst[1], m);
/** White-violet flash 0..1: a quick rise at the burst start, then a smooth fall. */
export const burstFlash = (m: number): number => ss(M.burst[0] - 0.005, M.burst[0] + 0.02, m) * (1 - ss(M.burst[0] + 0.02, M.burst[1] + 0.07, m));
/** Radius (world units) of the bubble the new star carves in its nebula: closed until the ignition flash (pp ~0.515), then
 *  opens (ease-out) past the outermost orbit (rMax + pad) by pp ~0.64 and stays. Pure in pp, so it scrubs and rewinds exactly. */
export const cavityR = (pp: number, rMax: number): number => (rMax + 1.6) * (1 - (1 - ss(0.512, 0.6, pp)) ** 3);
/** Volume gain multiplier: a short dip around the ignition (pp 0.5-0.6) so the flash reads against dark, not a bright wash. */
export const nebulaDip = (pp: number): number => 1 - 0.8 * ss(0.49, 0.525, pp) * (1 - ss(0.56, 0.64, pp));

/** Shock ring progress 0..1 (ease-out) and its alpha. */
export const shockK = (m: number): number => 1 - (1 - clamp01((m - M.burst[0] - 0.01) / (M.burst[1] + 0.08 - M.burst[0]))) ** 2.2;
export const shockAlpha = (m: number): number => ss(M.burst[0] + 0.005, M.burst[0] + 0.03, m) * (1 - ss(M.burst[0] + 0.05, M.burst[1] + 0.08, m));

/** Merge camera at m: starts on the overview, leans in while the planets fall, then pulls out to the whole galaxy. */
export function mergeCam(m: number, aspect: number, rMax: number): LateCam {
  const wide = aspect >= 1.2;
  const a = systemView(aspect, rMax);
  const offX = wide ? 0.33 + Math.max(0, 1.6 - aspect) * 0.25 : 0;
  const dist = wide ? Math.max(25, 10 / (TAN25 * aspect * (0.92 - offX))) : Math.max(52, 10 / (TAN25 * aspect * 0.9)); // galaxy radius is 10
  const fin = viewPose([0, 0, 0], dist, 0.84, 0, offX, wide ? -0.02 : -0.28, aspect);
  const k: { m: number; cam: V3; tg: V3 }[] = [
    { m: 0, cam: a.cam, tg: a.target },
    { m: 0.42, cam: systemView(aspect, rMax, 0.8).cam, tg: systemView(aspect, rMax, 0.8).target },
    { m: 1, cam: fin.cam, tg: fin.target }, // inclined about 42 deg like M51 (never edge-on, never face-on); far enough that the whole disc and both arms read
  ];
  let i = 0;
  while (i < k.length - 2 && m > k[i + 1].m) i++;
  const t = easeInOut(clamp01((m - k[i].m) / (k[i + 1].m - k[i].m)));
  const mix = (x: V3, y: V3): V3 => [lerp(x[0], y[0], t), lerp(x[1], y[1], t), lerp(x[2], y[2], t)];
  return { cam: mix(k[i].cam, k[i + 1].cam), target: mix(k[i].tg, k[i + 1].tg), fov: 50 };
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
  nebula: 0.02 * SPLIT,
  core: 0.55 * SPLIT,
  constellation: 0.9 * SPLIT,
  fan: SPLIT + 0.3 * (LATE_END - SPLIT),
  build: SPLIT + 0.62 * (LATE_END - SPLIT),
  verify: SPLIT + 0.78 * (LATE_END - SPLIT),
  cron: SPLIT + 0.935 * (LATE_END - SPLIT),
  merge: LATE_END + 0.3 * (1 - LATE_END),
  close: 1,
} as const;
