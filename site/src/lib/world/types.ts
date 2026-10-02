import type { PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three';
import type { Agent } from '../agents';
import type { ScrollState } from '../scroll';
import type { Honeycomb, Lattice } from './honeycomb';
import type { Flow } from './routes';
import type { RingFx } from './rings';
import type { WalkRoute } from './walk';
import type { Journey } from '../journeys';

export interface RoutingNames {
  /** the three quality-gate agents */
  gates: string[];
  /** the specialist the hive story routes to (first non-gate, non-explore agent of the T2 example) */
  specialist?: string;
  /** the routing tier the scrubbed hive route belongs to (the T2 example) */
  mainTier?: string;
  /** the tasks the page can tell, one per routing example (journeys.ts), and the one it tells unless the viewer picks another (the T2 example) */
  journeys: Journey[];
  defaultJourney: number;
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
  loop: number; // 0..1 through the finale's homecoming (the page loops; 0 anywhere else): the world blends the camera back to the intro's rest pose with it
  // persistent
  camFloor: number; // camera path never goes below this (intro sets it)
  lookYaw: number; // the walker's drag-to-look offsets (radians), written by the Cells chapter and applied by the world on the ground
  lookPitch: number;
  walk: number; // 0..1 how far the camera is into the ground walk (world.ts writes it every frame; chapters read the last frame's value)
  walkStop: number; // index of the tower the walker is approaching or holding at (a route stop; world.ts writes it while walking)
  journey: number; // index into routing.journeys of the task being told (the chooser writes it; the world builds that task's route when it changes)
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
  /** the comet's crisp ring effects on the globe surface (scan ring, arrival ripples) */
  readonly rings: RingFx;
  /** agent names from content/routing.ts, resolved at build time */
  readonly routing: RoutingNames;
  readonly scroll: { lock(reason: string): void; unlock(reason: string): void; setWalkSec(sec: number): void };
  /** current honeycomb (globe + moon) (replaced on a tier change: never cache it) */
  readonly comb: Honeycomb;
  /** the walk route once it is built (a little before the Cells chapter), else null */
  readonly walkRoute: WalkRoute | null;
  time: number;
  dt: number;
  cellIndex(name: string): number;
  cellTop(name: string, out: Vector3): Vector3 | null;
  /** request a panel lift and tone brightening for this frame (0..1); the world smooths it. Never self-lit. */
  hilite(name: string, amount: number): void;
}

export interface Chapter {
  enter(): void;
  /** opacity of this chapter's pinned scene (the world drives it, so neighbouring scenes cross-fade with matched curves) */
  fade(v: number): void;
  /** progress is chapterProgress 0..1 */
  update(progress: number): void;
  exit(): void;
  dispose?(): void;
}
