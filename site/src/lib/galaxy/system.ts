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
    launchIndex: w.launchIndex,
    buildIndex: w.buildIndex,
    mergeIndex: w.mergeIndex,
    verify: verifyFor(w),
  }));
  const troubled = planets.find((p) => p.verify.resolution === 'fixer');
  return { planets, closeUp: troubled !== undefined ? troubled.slug : null };
}

// Rest position on the circular orbit in the XZ plane (y = 0).
export function planetPos(p: Planet, t: number): V3 {
  const a = p.phase + p.speed * t;
  return [0 + p.orbit * Math.cos(a), 0, 0 + p.orbit * Math.sin(a)];
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
  const a = p.phase + p.speed * t - (1 - k) * 1.2;
  return [0 + r * Math.cos(a), 0, 0 + r * Math.sin(a)];
}

// Merge arc: in-spiral from the orbit (k=0) to the core (k=1).
export function spiralIn(p: Planet, k: number, t: number): V3 {
  if (k >= 1) return [0, 0, 0];
  const r = p.orbit * (1 - k) ** 1.6;
  const a = p.phase + p.speed * t + k * 2.5;
  return [0 + r * Math.cos(a), 0, 0 + r * Math.sin(a)];
}

// Verify beat: red failure pulses over the first 70% of u, green pass ramp
// over the last 30%; clean planets ramp green early and never flash red.
export function flashPhase(v: VerifyPlan, u: number): { red: number; green: number } {
  const x = clamp01(u);
  if (v.redFlashes <= 0) return { red: 0, green: clamp01(x / 0.4) };
  const red = x < 0.7 ? Math.sin(Math.PI * (((x / 0.7) * v.redFlashes) % 1)) ** 2 : 0;
  return { red, green: clamp01((x - 0.7) / 0.3) };
}
