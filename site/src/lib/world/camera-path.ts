import { CatmullRomCurve3, Vector3 } from 'three';
import type { Lattice } from './honeycomb';

// One curve for the whole site: the camera ORBITS a still globe (origin, core cell on +Z, moon to +X). Control
// points are evenly spaced in curve parameter u (index / (N-1)), so each chapter's [t0,t1] must land on point
// indices: the chapter data below is the single place that says which points belong to which chapter.
// Everything is in multiples of L, the globe radius, so the path follows the globe if its size changes.
// Points are written as orbit(azimuth deg from the core, elevation deg, distance in L).

export type ChapterName = 'intro' | 'hive' | 'cells' | 'proof' | 'finale';
export interface ChapterSegment {
  chapter: number;
  name: ChapterName;
  t0: number;
  t1: number;
  /** look-at target at chapter start and end, in multiples of L */
  lookAt: [Vector3, Vector3];
  /** fly-over: mid-chapter the target is the globe surface this far ahead on the path (global progress), blended over `lookAt` at the ends */
  lookAhead?: number;
}

export interface CameraPath {
  segments: ChapterSegment[];
  /** writes camera position and look-at target for globalProgress in [0,1] */
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
// proof/finale look slightly to the moon-free side so the moon leaves the frame
const PROOF_LOOK = v(-0.15, -0.05, 0);

// point index ranges: intro 0-3, hive 3-8, cells 8-14, proof 14-18, finale 18-20 (N=21)
const N_INTERVALS = 20;
const at = (i: number) => i / N_INTERVALS;

export const SEGMENTS: ChapterSegment[] = [
  { chapter: 0, name: 'intro', t0: at(0), t1: at(3), lookAt: [CORE_TOP, HIVE_LOOK] },
  { chapter: 1, name: 'hive', t0: at(3), t1: at(8), lookAt: [HIVE_LOOK, HIVE_LOOK] },
  { chapter: 2, name: 'cells', t0: at(8), t1: at(14), lookAt: [v(-0.35, 0.05, 0.9), MOON], lookAhead: 0.06 },
  { chapter: 3, name: 'proof', t0: at(14), t1: at(18), lookAt: [MOON, PROOF_LOOK] },
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

export function createCameraPath(lattice: Lattice): CameraPath {
  const L = lattice.radius;
  MOON.copy(lattice.moon.centre).multiplyScalar(1 / L);
  const S = (p: Vector3) => p.clone().multiplyScalar(L);
  const points = [
    // 0 intro: close to the core cell, then pull back so every growing ring is in frame
    orbit(4, 17, 2.0), orbit(8, 19, 2.6), orbit(12, 20, 3.3), orbit(14, 21, 4.0),
    // 3 hive: the whole globe and its moon in frame, a slow drift round to the core-facing side
    orbit(14, 21, 4.1), orbit(10, 21, 4.15), orbit(5, 22, 4.2), orbit(0, 22, 4.2), orbit(-5, 22, 4.15),
    // 8 cells: descend to a low fly-over across the front hemisphere, end beside the moon
    orbit(-45, 30, 2.8), orbit(-62, 22, 2.25), orbit(-32, 14, 2.15), orbit(6, 12, 2.15),
    orbit(24, 16, 2.25), orbit(34, 22, 2.6),
    // 14 proof: rise and recede to a wide, dim view from the side away from the moon
    orbit(20, 30, 2.7), orbit(-20, 32, 3.6), orbit(-60, 30, 4.3), orbit(-88, 26, 4.7),
    // 18 finale (stub): slow drift
    orbit(-95, 28, 4.8), orbit(-102, 30, 4.9),
  ].map(S);
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
      tmpA.copy(a).multiplyScalar(L);
      tmpB.copy(b).multiplyScalar(L);
      target.lerpVectors(tmpA, tmpB, smooth(chapterProgress));
      const ahead = SEGMENTS[chapter].lookAhead;
      if (ahead) {
        // the surface a little way along the path, weighted in mid-chapter so the ends keep their framed targets
        const w = smooth(Math.min(1, chapterProgress / 0.15)) * (1 - smooth(Math.min(1, Math.max(0, (chapterProgress - 0.8) / 0.2))));
        curve.getPoint(Math.min(1, g + ahead), tmpA).setLength(L * 0.6);
        target.lerp(tmpA, w);
      }
    },
  };
}
