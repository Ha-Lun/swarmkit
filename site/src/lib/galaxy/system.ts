// Solar-system layout derived from the story model. Pure math (no DOM, no
// three.js) so it runs under node --test and in the R3F scene alike.
import type { Story, StoryWorker } from './story.ts';
import type { Lane } from '../run.ts';
import { clamp01 } from './path.ts';
import type { V3 } from './path.ts';

export type { V3 };

export interface VerifyPlan {
  redFlashes: number; // = failedVerifies
  resolution: 'clean' | 'resume' | 'fixer';
  fixer: { slug: string; lane: Lane } | null;
}

export interface Planet {
  slug: string;
  lane: Lane;
  orbit: number; // radius, world units
  phase: number; // radians at t=0
  speed: number; // radians per unit t (inner planets faster: orbit^-1.5, outermost 0.15)
  incl: number; // radians, orbit inclination (0.5..3 deg)
  node: number; // radians, longitude of the ascending node
  launchIndex: number;
  buildIndex: number;
  mergeIndex: number | null;
  verify: VerifyPlan;
}

const R0 = 1.6;
const R1 = 6.0;
const GOLDEN = 2.399963; // golden angle: consecutive planets never line up
const TAU = Math.PI * 2;

const smooth = (t: number): number => t * t * (3 - 2 * t);
const easeOutCubic = (k: number): number => 1 - (1 - k) ** 3;

function verifyFor(w: StoryWorker): VerifyPlan {
  if (w.fixer !== null) return { redFlashes: w.failedVerifies, resolution: 'fixer', fixer: w.fixer };
  if (w.failedVerifies > 0) return { redFlashes: w.failedVerifies, resolution: 'resume', fixer: null };
  return { redFlashes: w.failedVerifies, resolution: 'clean', fixer: null };
}

// Planets in launchIndex order: evenly spaced radii, golden-angle phases,
// Keplerian speeds. Portrait aspects shrink every orbit toward the sun.
export function buildSystem(story: Pick<Story, 'workers'>, aspect: number): { planets: Planet[]; closeUp: string | null } {
  const n = story.workers.length;
  const ordered = [...story.workers].sort((a, b) => a.launchIndex - b.launchIndex);
  const shrink = aspect < 1 ? Math.max(0.7, aspect + 0.25) : 1;
  const radii = ordered.map((_, i) => (R0 + (R1 - R0) * (n > 1 ? i / (n - 1) : 0)) * shrink);
  const rMax = Math.max(...radii);
  const planets: Planet[] = ordered.map((w, i) => ({
    slug: w.slug,
    lane: w.lane,
    orbit: radii[i],
    phase: (((-0.6 + i * GOLDEN) % TAU) + TAU) % TAU,
    speed: 0.15 * (rMax / radii[i]) ** 1.5,
    incl: (i % 2 === 0 ? 1 : -1) * (0.5 + 2.5 * (i * 0.618034 + 0.31 - Math.floor(i * 0.618034 + 0.31))) * Math.PI / 180,
    node: ((i * GOLDEN * 1.7) % TAU + TAU) % TAU,
    launchIndex: w.launchIndex,
    buildIndex: w.buildIndex,
    mergeIndex: w.mergeIndex,
    verify: verifyFor(w),
  }));
  const troubled = planets.find((p) => p.verify.resolution === 'fixer');
  return { planets, closeUp: troubled !== undefined ? troubled.slug : null };
}

// Rotate a point in the orbit's own XZ plane by inclination incl about the
// line of nodes (unit vector (cos node, 0, sin node) in the XZ plane).
export function tilt(p: Pick<Planet, 'incl' | 'node'>, v: V3): V3 {
  if (v[0] === 0 && v[1] === 0 && v[2] === 0) return [0, 0, 0];
  const kx = Math.cos(p.node);
  const kz = Math.sin(p.node);
  const c = Math.cos(p.incl);
  const s = Math.sin(p.incl);
  const [x, y, z] = v;
  const dot = kx * x + kz * z;
  const cx = -kz * y;
  const cy = kz * x - kx * z;
  const cz = kx * y;
  const fix = (n: number): number => (n === 0 ? 0 : n);
  return [fix(x * c + cx * s + kx * dot * (1 - c)), fix(y * c + cy * s), fix(z * c + cz * s + kz * dot * (1 - c))];
}

// Rest position on the circular orbit, tilted by incl about the line of nodes.
export function planetPos(p: Planet, t: number): V3 {
  const a = p.phase + p.speed * t;
  return tilt(p, [0 + p.orbit * Math.cos(a), 0, 0 + p.orbit * Math.sin(a)]);
}

// Global progress u in 0..1 mapped to item i of n (smoothstep easing).
// Used for launch (index launchIndex) and build (index buildIndex).
export function stagger(u: number, i: number, n: number, span = 0.6): number {
  const start = n > 1 ? (i / (n - 1)) * (1 - span) : 0;
  return smooth(clamp01((u - start) / span));
}

// Launch arc: outward spiral from the sun (k=0) to the orbit (k=1).
export function launchPos(p: Planet, k: number, t: number): V3 {
  const r = p.orbit * easeOutCubic(k);
  if (r === 0) return [0, 0, 0];
  const a = p.phase + p.speed * t - (1 - k) * 1.2;
  return tilt(p, [0 + r * Math.cos(a), 0, 0 + r * Math.sin(a)]);
}

// Merge arc: in-spiral from the orbit (k=0) to the core (k=1).
export function spiralIn(p: Planet, k: number, t: number): V3 {
  if (k >= 1) return [0, 0, 0];
  const r = p.orbit * (1 - k) ** 1.6;
  const a = p.phase + p.speed * t + k * 2.5;
  return tilt(p, [0 + r * Math.cos(a), 0, 0 + r * Math.sin(a)]);
}

// Verify beat: red failure pulses over the first 70% of u, green pass ramp
// over the last 30%; clean planets ramp green early and never flash red.
export function flashPhase(v: VerifyPlan, u: number): { red: number; green: number } {
  const x = clamp01(u);
  if (v.redFlashes <= 0) return { red: 0, green: clamp01(x / 0.4) };
  const red = x < 0.7 ? Math.sin(Math.PI * (((x / 0.7) * v.redFlashes) % 1)) ** 2 : 0;
  return { red, green: clamp01((x - 0.7) / 0.3) };
}
