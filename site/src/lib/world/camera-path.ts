import { CatmullRomCurve3, Vector3 } from 'three';
import { SATELLITE_DIR, SATELLITE_GAP } from './honeycomb';

// One curve for the whole site. Control points are evenly spaced in curve parameter u
// (index / (N-1)), so each chapter's [t0,t1] must land on point indices: the chapter
// data below is the single place that says which points belong to which chapter.
// Chapter 0 is in absolute world units (close to one cell). Later chapters are in
// multiples of L, the lattice radius, so the path follows the lattice as it changes size.

export type ChapterName = 'intro' | 'hive' | 'cells' | 'proof' | 'finale';
export interface ChapterSegment {
  chapter: number;
  name: ChapterName;
  t0: number;
  t1: number;
  /** look-at target at chapter start and end, in multiples of L (or absolute for chapter 0) */
  lookAt: [Vector3, Vector3];
}

export interface CameraPath {
  segments: ChapterSegment[];
  /** writes camera position and look-at target for globalProgress in [0,1] */
  sample(globalProgress: number, pos: Vector3, target: Vector3): void;
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z);

// Satellite cluster centre in units of L; filled in by createCameraPath(L) from honeycomb's constants.
const SAT = v(0, 0, 0);
const ORIGIN = v(0, 0, 0);
// proof/finale aim slightly toward the camera side so the far satellite cluster leaves the frame
const PROOF_LOOK = v(-0.3, 0, -0.18);

// point index ranges: intro 0-3, hive 3-8, cells 8-14, proof 14-18, finale 18-20 (N=21)
const N_INTERVALS = 20;
const at = (i: number) => i / N_INTERVALS;

export const SEGMENTS: ChapterSegment[] = [
  { chapter: 0, name: 'intro', t0: at(0), t1: at(3), lookAt: [v(0, 0.6, 0), v(0, 0, 0)] },
  { chapter: 1, name: 'hive', t0: at(3), t1: at(8), lookAt: [ORIGIN, v(0.4, 0, 0.2)] },
  { chapter: 2, name: 'cells', t0: at(8), t1: at(14), lookAt: [ORIGIN, SAT] },
  { chapter: 3, name: 'proof', t0: at(14), t1: at(18), lookAt: [SAT, PROOF_LOOK] },
  { chapter: 4, name: 'finale', t0: at(18), t1: at(20), lookAt: [PROOF_LOOK, PROOF_LOOK] },
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

const smooth = (t: number) => t * t * (3 - 2 * t);

export function createCameraPath(L: number): CameraPath {
  SAT.set(((L + SATELLITE_GAP) * Math.cos(SATELLITE_DIR)) / L, 0, ((L + SATELLITE_GAP) * Math.sin(SATELLITE_DIR)) / L);
  const A = v; // absolute world units
  const S = (x: number, y: number, z: number) => v(x * L, y * L, z * L); // lattice-radius units
  const points = [
    // 0 intro: one cell, then an early pull out so every growing ring is in frame
    A(0.6, 3.4, 5.2), A(3.0, 7.0, 10.0), A(6.5, 13.0, 18.5), A(9.0, 18.0, 25.0),
    // 3 hive: reach the full-lattice view (satellite cluster included) by mid-chapter, then hold
    S(0.75, 1.5, 2.1), S(0.65, 1.7, 2.3), S(0.6, 1.8, 2.4), S(0.55, 1.8, 2.4), S(0.5, 1.75, 2.35),
    // 8 cells: descend and fly along the lattice, end near the satellite cluster
    S(-0.7, 1.0, 0.9), S(-0.95, 0.3, 0.35), S(-0.55, 0.22, -0.5), S(0.25, 0.22, -0.75),
    S(0.6, 0.3, -0.35), S(0.85, 0.45, 0.15),
    // 14 proof: rise over the lattice and settle opposite the satellite so it stays out of frame
    S(0.3, 1.2, 0.1), S(-0.3, 1.4, -0.2), S(-0.7, 1.4, -0.45), S(-0.95, 1.3, -0.55),
    // 18 finale (stub): slow drift
    S(-1.0, 1.4, -0.6), S(-1.05, 1.6, -0.65),
  ];
  if (points.length !== N_INTERVALS + 1) throw new Error('camera-path: point count must match SEGMENTS');
  const curve = new CatmullRomCurve3(points, false, 'catmullrom', 0.5);
  const tmpA = new Vector3();
  const tmpB = new Vector3();

  return {
    segments: SEGMENTS,
    sample(globalProgress, pos, target) {
      const g = Math.min(1, Math.max(0, globalProgress));
      curve.getPoint(g, pos);
      const { chapter, chapterProgress } = chapterAt(g);
      const [a, b] = SEGMENTS[chapter].lookAt;
      const scale = chapter === 0 ? 1 : L;
      tmpA.copy(a).multiplyScalar(scale);
      tmpB.copy(b).multiplyScalar(scale);
      target.lerpVectors(tmpA, tmpB, smooth(chapterProgress));
    },
  };
}
