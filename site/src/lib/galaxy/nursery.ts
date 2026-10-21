// Star-nursery layout + timing: N young stars born in the bubble wall around
// Opus (the origin). Pure math (no DOM, no three.js) so it runs under node --test and in
// the R3F scene alike. All progress inputs are 0..1 (pp = legacy plan beat,
// u = late beats), so everything scrubs and rewinds exactly.
import type { Story, StoryWorker } from './story.ts';
import type { Lane } from '../run.ts';
import { clamp01, ss, win } from './path.ts';
import { L } from './path.ts';
import type { V3 } from './path.ts';
export type { V3 };

export interface VerifyPlan {
  redFlashes: number; // = failedVerifies
  resolution: 'clean' | 'resume' | 'fixer';
  fixer: { slug: string; lane: Lane } | null;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Global progress u in 0..1 mapped to item i of n (smoothstep easing); the stagger of every nursery beat. */
export function stagger(u: number, i: number, n: number, span = 0.6): number {
  const start = n > 1 ? (i / (n - 1)) * (1 - span) : 0;
  return smooth(clamp01((u - start) / span));
}

/** Verify beat: red failure pulses over the first 70% of u, then the star settles (green ramp over the last 30%);
 *  clean stars ramp green early and never flash red. */
export function flashPhase(v: VerifyPlan, u: number): { red: number; green: number } {
  const x = clamp01(u);
  if (v.redFlashes <= 0) return { red: 0, green: clamp01(x / 0.4) };
  const red = x < 0.7 ? Math.sin(Math.PI * (((x / 0.7) * v.redFlashes) % 1)) ** 2 : 0;
  return { red, green: clamp01((x - 0.7) / 0.3) };
}

/** The close-up star over the dwell (c 0..1): red sputters (redFlashes of them) until c = 0.5, the fixer feeds it
 *  c 0.5..0.9 (feed 0..1..0), and it holds a steady burn (green) from there. */
export function cronPhase(redFlashes: number, c: number): { red: number; green: number; feed: number } {
  const x = clamp01(c / 0.5);
  const red = redFlashes > 0 && x < 1 ? Math.sin(Math.PI * ((x * redFlashes) % 1)) ** 2 : 0;
  return { red, green: ss(0.62, 0.9, c), feed: ss(0.5, 0.58, c) * (1 - ss(0.86, 0.93, c)) };
}

export interface Young {
  slug: string;
  lane: Lane;
  pos: V3; // bubble-wall position, unit dir * radius
  dir: V3; // unit vector from Opus (origin) to pos
  launchIndex: number;
  buildIndex: number;
  mergeIndex: number | null;
  rank: number; // 0-based order by launchIndex
  verify: VerifyPlan;
}

const GOLDEN = 2.399963; // golden angle: consecutive stars never line up
const TH_MIN = (55 * Math.PI) / 180; // band around VIEW_DIR: no star in front of
const TH_MAX = (125 * Math.PI) / 180; // Opus, none hidden straight behind it

/** Direction from Opus toward the overview camera (normalize([0, 0.47, 0.88])). */
const VD_LEN = Math.hypot(0.47, 0.88);
export const VIEW_DIR: V3 = [0, 0.47 / VD_LEN, 0.88 / VD_LEN];

const frac = (x: number): number => x - Math.floor(x);

// Verify beat plan of one worker.
export function verifyFor(w: StoryWorker): VerifyPlan {
  if (w.fixer !== null) return { redFlashes: w.failedVerifies, resolution: 'fixer', fixer: w.fixer };
  if (w.failedVerifies > 0) return { redFlashes: w.failedVerifies, resolution: 'resume', fixer: null };
  return { redFlashes: w.failedVerifies, resolution: 'clean', fixer: null };
}

// One candidate layout: golden-angle azimuth around VIEW_DIR, polar angle
// inside the band, a per-star radius wobble, all offset by `rot`.
function layout(ordered: { slug: string; lane: Lane; launchIndex: number; buildIndex: number; mergeIndex: number | null }[], shell: number, rot: number): V3[] {
  const vd = VIEW_DIR;
  // Orthonormal basis across the band: e1, e2 perpendicular to VIEW_DIR.
  const e1: V3 = [-vd[2], 0, vd[0]];
  const l1 = Math.hypot(e1[0], e1[1], e1[2]) || 1;
  e1[0] /= l1;
  e1[2] /= l1;
  const e2: V3 = [
    vd[1] * e1[2] - vd[2] * e1[1],
    vd[2] * e1[0] - vd[0] * e1[2],
    vd[0] * e1[1] - vd[1] * e1[0],
  ];
  return ordered.map((_, i) => {
    const az = i * GOLDEN + rot;
    const th = TH_MIN + (TH_MAX - TH_MIN) * frac(i * 0.7548776662 + 0.437);
    const r = shell * (1 + 0.08 * (2 * frac(i * 0.7548776662 + 0.21) - 1));
    const t = Math.sin(th);
    return [
      r * (Math.cos(th) * vd[0] + t * (Math.cos(az) * e1[0] + Math.sin(az) * e2[0])),
      r * (Math.cos(th) * vd[1] + t * (Math.cos(az) * e1[1] + Math.sin(az) * e2[1])),
      r * (Math.cos(th) * vd[2] + t * (Math.cos(az) * e1[2] + Math.sin(az) * e2[2])),
    ];
  });
}

function minPairDist(pts: V3[]): number {
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i][0] - pts[j][0];
      const dy = pts[i][1] - pts[j][1];
      const dz = pts[i][2] - pts[j][2];
      min = Math.min(min, Math.hypot(dx, dy, dz));
    }
  }
  return pts.length < 2 ? Infinity : min;
}

export interface Nursery {
  stars: Young[];
  closeUp: string | null;
  extent: number;
}

/** Stars in launchIndex order on the bubble wall (radius shellR, +-8% wobble,
 *  portrait shells shrink like system.ts). The band keeps every star off the
 *  Opus-camera line; if a layout crowds pairs below the minimum separation the
 *  azimuth offsets rotate deterministically (64 tries, then the best found). */
export function buildNursery(story: Pick<Story, 'workers'>, aspect: number, shellR = 5.6): Nursery {
  const n = story.workers.length;
  const ordered = [...story.workers].sort((a, b) => a.launchIndex - b.launchIndex);
  if (n === 0) return { stars: [], closeUp: null, extent: 0 };
  const shell = shellR * (aspect < 1 ? Math.max(0.72, aspect + 0.25) : 1);
  const minSep = 0.9 * shellR * Math.sqrt(4 / n) * 0.5;
  let best: V3[] = layout(ordered, shell, 0);
  let bestDist = minPairDist(best);
  for (let attempt = 1; attempt < 64 && bestDist < minSep; attempt++) {
    const pts = layout(ordered, shell, attempt * 0.35 * GOLDEN);
    const d = minPairDist(pts);
    if (d > bestDist) {
      bestDist = d;
      best = pts;
    }
  }
  const stars: Young[] = ordered.map((w, i) => {
    const [x, y, z] = best[i];
    const r = Math.hypot(x, y, z) || 1;
    const dir: V3 = [x / r, y / r, z / r];
    return {
      slug: w.slug,
      lane: w.lane,
      pos: best[i],
      dir,
      launchIndex: w.launchIndex,
      buildIndex: w.buildIndex,
      mergeIndex: w.mergeIndex,
      rank: i,
      verify: verifyFor(w),
    };
  });
  const troubled = stars.find((s) => s.verify.resolution === 'fixer');
  return {
    stars,
    closeUp: troubled !== undefined ? troubled.slug : null,
    extent: stars.reduce((m, s) => Math.max(m, Math.hypot(s.pos[0], s.pos[1], s.pos[2])), 0),
  };
}

// ---- timing helpers (knots, threads, ignition, cocoons, test pulses) --------

/** Plan-beat window the knot rings glow in (legacy progress pp). */
const KNOT: readonly [number, number] = [0.56, 0.75];

/** Knot glow-in 0..1 of ring i of n during the plan beat; 0 before, 1 after. */
export const knotK = (pp: number, i: number, n: number): number => stagger(win(KNOT, pp), i, n, 0.5);

/** u the thread of light reaches star i (stagger share 0.5 inside L.fan). */
const threadArrival = (i: number, n: number): number =>
  L.fan[0] + (0.5 + 0.5 * (n > 1 ? i / (n - 1) : 0)) * (L.fan[1] - L.fan[0]);

/** Thread of light from Opus reaching star i of n over L.fan: 0 before, 1 once it lands. */
export const threadK = (u: number, i: number, n: number): number => stagger(win(L.fan, u), i, n, 0.5);

/** Ignition of star i: a short smoothstep right after its thread lands; 0 while the thread is short of the star. */
export function igniteK(u: number, i: number, n: number): number {
  if (threadK(u, i, n) < 1) return 0;
  const a = threadArrival(i, n);
  return ss(a, a + 0.04, u);
}

/** Build (cocoon) progress 0..1 of the star with build index bi of n over L.build. */
export const cocoonK = (u: number, bi: number, n: number): number => stagger(win(L.build, u), bi, n, 0.5);

/** Test-pulse start in u for star `rank` of n (inner ranks start first). */
const pulseStart = (rank: number, n: number): number =>
  L.scan[0] + (L.scan[1] - L.scan[0]) * 0.6 * (rank / Math.max(1, n - 1));
const PULSE_DUR = 0.4 * (L.scan[1] - L.scan[0]);

/** Test-pulse position along the thread: 0 at Opus, 1 at the star, during L.scan. */
export const testPulseK = (u: number, rank: number, n: number): number =>
  clamp01((u - pulseStart(rank, n)) / PULSE_DUR);

/** Verify progress (flashPhase input) of the star: starts when its test pulse lands, runs for L.tick. */
export const verifyU = (u: number, rank: number, n: number): number =>
  clamp01((u - (pulseStart(rank, n) + PULSE_DUR)) / L.tick);

/** Merge infall (k = pullK 0..1): the star falls from its bubble-wall position to Opus along a gently curving path:
 *  it swings about the view axis by up to ~100 degrees as it sinks (faster near the end, like angular momentum
 *  conserving) so the cluster tightens in a slight inward spiral. k = 0 is `pos`, k = 1 is Opus (the origin). */
export function infallPos(pos: V3, k: number): V3 {
  const kk = clamp01(k);
  const r = 1 - kk;
  const a = 1.75 * (1 - Math.sqrt(r)); // swing angle about VIEW_DIR
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const ax = VIEW_DIR;
  const d = ax[0] * pos[0] + ax[1] * pos[1] + ax[2] * pos[2];
  const cx: V3 = [ax[1] * pos[2] - ax[2] * pos[1], ax[2] * pos[0] - ax[0] * pos[2], ax[0] * pos[1] - ax[1] * pos[0]];
  // Rodrigues rotation, then the radial shrink (kept fully to the origin at k = 1)
  const o: V3 = [0, 1, 2].map((q) => (pos[q] * c + cx[q] * sn + ax[q] * d * (1 - c)) * r) as V3;
  return [o[0] + 0, o[1] + 0, o[2] + 0];
}
