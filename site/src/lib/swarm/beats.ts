// Scroll-progress -> beat mapping for the swarm showcase: 8 equal-height story
// sections tile [0, 1], one beat each, in BEATS order. scroll progress over the
// story container maps 1:1 to beatAt.
export type FormationId = 'disk' | 'lattice' | 'streams' | 'towers' | 'hex' | 'ring' | 'trio';
export type BeatId = 'hero' | 'plan' | 'fanout' | 'build' | 'merge' | 'numbers' | 'clis' | 'cta';

export interface Beat {
  id: BeatId;
  formation: FormationId;
  start: number;
  end: number;
}

/** 8 beats, equal ranges of 1/8, contiguous, first start 0, last end 1. */
export const BEATS: readonly Beat[] = [
  { id: 'hero', formation: 'disk', start: 0 / 8, end: 1 / 8 },
  { id: 'plan', formation: 'lattice', start: 1 / 8, end: 2 / 8 },
  { id: 'fanout', formation: 'streams', start: 2 / 8, end: 3 / 8 },
  { id: 'build', formation: 'towers', start: 3 / 8, end: 4 / 8 },
  { id: 'merge', formation: 'hex', start: 4 / 8, end: 5 / 8 },
  { id: 'numbers', formation: 'ring', start: 5 / 8, end: 6 / 8 },
  { id: 'clis', formation: 'trio', start: 6 / 8, end: 7 / 8 },
  { id: 'cta', formation: 'disk', start: 7 / 8, end: 8 / 8 },
];

export interface BeatState {
  index: number; // index of the current beat
  beat: BeatId;
  local: number; // 0..1 progress inside the current beat
  from: FormationId; // current beat's formation
  to: FormationId; // next beat's formation (same as from for the last beat)
  mix: number; // 0..1 morph from -> to
}

const clamp01 = (x: number): number => (Number.isNaN(x) || x <= 0 ? 0 : x >= 1 ? 1 : x);
const smooth = (x: number): number => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

/** progress is clamped to [0,1]. Each beat HOLDS its formation (mix 0) for local
 *  < 0.5, then morphs to the next beat's formation over local 0.5..1 with
 *  smoothstep easing (mix reaches 1 at local=1). Last beat: mix always 0. */
export function beatAt(progress: number): BeatState {
  const p = clamp01(progress);
  const index = Math.min(BEATS.length - 1, Math.floor(p * BEATS.length));
  const local = p * BEATS.length - index;
  const from = BEATS[index].formation;
  const last = index === BEATS.length - 1;
  const to = last ? from : BEATS[index + 1].formation;
  const mix = last || local < 0.5 ? 0 : smooth((local - 0.5) * 2);
  return { index, beat: BEATS[index].id, local, from, to, mix };
}
