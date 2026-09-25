import type { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { Agent } from '../agents';
import type { ScrollState } from '../scroll';
import type { Honeycomb, Lattice } from './honeycomb';
import type { Flow } from './routes';

export interface RoutingNames {
  /** the three quality-gate agents */
  gates: string[];
  /** the specialist the hive story routes to (first non-gate, non-explore agent of the T2 example) */
  specialist?: string;
  /** the routing tier the scrubbed hive route belongs to (the T2 example) */
  mainTier?: string;
}

export type ActiveTier = 'high' | 'medium';

/** What chapters write each frame. The world resets the per-frame fields before every chapter update. */
export interface View {
  // per-frame (reset before chapter.update)
  growth: number;
  dim: number;
  dissolve: number; // 0..1 hex dissolve between the end of the cells view and the live view
  canvasOpacity: number;
  latticeVisible: boolean;
  swarmFade: number; // 0 = swarm not rendered
  swarmAttract: number;
  focus: Vector3; // look-at target bias
  focusWeight: number;
  focusDrop: number; // lowers the look-at target (x camera distance) so the focus sits higher on screen, clear of the DOM panels
  overview: number; // 0..1 blend toward the wide hive view of the whole lattice
  // persistent
  camFloor: number; // camera path never goes below this (intro sets it)
}

export interface WorldCtx {
  readonly agents: Agent[];
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  readonly state: Readonly<ScrollState>; // read-only view of the scroll state
  readonly view: View;
  readonly lattice: Lattice;
  readonly flows: Flow[];
  /** agent names from content/routing.ts, resolved at build time */
  readonly routing: RoutingNames;
  readonly scroll: { lock(): void; unlock(): void };
  /** current honeycomb (globe + moon) (replaced on a tier change: never cache it) */
  readonly comb: Honeycomb;
  time: number;
  dt: number;
  cellIndex(name: string): number;
  cellTop(name: string, out: Vector3): Vector3 | null;
  /** request a cell glow/lift for this frame (0..1 scaled by motion.glow); the world smooths it */
  glow(name: string, amount: number): void;
}

export interface Chapter {
  enter(): void;
  /** progress is chapterProgress 0..1 */
  update(progress: number): void;
  exit(): void;
  dispose?(): void;
}
