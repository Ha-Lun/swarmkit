// SwarmKit City: the contract between the pure engine (lots.ts, timeline.ts) and the visual parts (blueprint,
// buildings, drones, scan, merge, tilt-shift). Visual parts are written separately and only see this file, so every
// field says its unit and meaning. Type-only imports keep this file erasable under plain node.
//
// Coordinates: metres. Ground plane y = 0, +y up. The blueprint plot (where the run's new lots are built) is centred
// on the origin; rows of lots run along z, columns along x. The existing city block (the codebase the lots merge
// into) sits on the -x side of the plot, across a road. Lane depots sit off the plot's -z and +z edges, one per lane.
// Angles are radians; a yaw of 0 faces +z, positive yaw turns towards +x (atan2(dx, dz)).
//
// Colour never lives in the engine: a lane is only an id; visual parts receive a CityPalette (read from CSS tokens
// by scene.ts) and map ids to colours there.

import type { Object3D } from 'three';
import type { Kit } from './kit.ts';
import type { Lane } from '../run.ts';
export type { Lane };

/** A vendor lane that ran workers. Canonical ids live in ../run.ts. Every lane the scene knows, in depot order: index 0 is the -z depot, index 1 the +z depot. */
export const LANES: readonly Lane[] = ['agy', 'opencode'];

/** Axis-aligned rectangle on the ground. x, z = centre (m); w = size along x (m); d = size along z (m). */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** One lot: a worker's part of the plan (or an extra branch such as a review-fix pass) as a building site. */
export interface Lot extends Rect {
  /** Worker slug from the run (also the DOM label text). Unique within a layout. */
  slug: string;
  /** Lane that built it: its drones come from this lane's depot. */
  lane: Lane;
  /** True for an extra branch with no original worker and no base worker (e.g. `review-fixes`). Extras are built
   *  straight into the annex next to the city block, never on the plot. Fixers stacked on a worker branch (an extra
   *  dispatch with `base`, e.g. `cronfix`) are NOT lots: they show as rework on their base worker's lot. */
  extra: boolean;
  /** Finished building height in metres (y extent from the ground). Derived from tokens on a clamped log scale. */
  height: number;
  /** False when the run recorded no tokens for it (tokens 0, or an extra); height is then a neutral stand-in
   *  (median of the known tokens, or a small fixed annex height) and the DOM must not quote a token count. */
  tokensKnown: boolean;
}

/** Where a lot ends up after the merge, in the city block (or the annex for extras). Same footprint as its lot. */
export interface Slot extends Rect {
  slug: string;
}

/** A building of the code that existed before the run: decorative, not data. Footprint plus height (m). */
export interface ExistingBuilding extends Rect {
  height: number;
}

/** A lane's hangar. */
export interface Depot {
  lane: Lane;
  /** Centre on the ground (m). */
  x: number;
  z: number;
  /** Yaw (rad, 0 = facing +z) so the open front faces the plot centre. */
  facing: number;
  /** True if the run used this lane at all. An unused lane's depot stays dark and sends no drones. */
  used: boolean;
}

/** A straight road strip on the ground, revealed during the merge. Endpoints are centreline points (m). */
export interface RoadSegment {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  /** Strip width (m). */
  width: number;
}

/**
 * Output of buildLayout(run). Invariants (checked by test/city/lots.test.ts):
 * - plot lots (extra=false) lie inside `plot` and never overlap each other;
 * - extra lots lie inside the annex, outside the plot and outside every block slot, never overlapping;
 * - block slots never overlap each other and lie inside `cityBlock`;
 * - `existing` buildings lie inside `cityBlock` and never overlap each other, a block slot, the annex or a road;
 * - `block[i]` is the merge target of `lots[i]` (same slug, same w and d); for an extra it equals its annex slot;
 * - depots lie outside the plot; the layout is a pure function of the run (no randomness).
 */
export interface LotLayout {
  /** The blueprint plot the run builds on, centred on the origin. */
  plot: Rect;
  /** Lot pitch on the plot (m): lot size plus the gap between lots. */
  cell: number;
  /** Original-worker lots first (in plot order), then extras (in dispatch order). */
  lots: Lot[];
  /** Merge target per lot, parallel to `lots`. */
  block: Slot[];
  /** Annex slots, one per extra lot, in the same order as the extras in `lots`. */
  annex: Slot[];
  /** Bounds of the city on the -x side: the existing city plus the empty slots the new lots merge into (and the
   *  roads between them). The slots sit on its +x edge, facing the plot across the link road. */
  cityBlock: Rect;
  /** The code that existed before the run: decorative, not data. Seeded and deterministic, filling `cityBlock`
   *  around the (empty until merged) block slots, never on a slot, road or annex lot. Empty when the run has no
   *  workers. Always visible. */
  existing: ExistingBuilding[];
  /** One per entry of LANES, in that order. */
  depots: Depot[];
  /** Roads of the merged block: perimeter, the streets between slots, and the link to the plot. */
  roads: RoadSegment[];
  /** Everything above (plot, block, annex, depots) for camera framing. */
  bounds: Rect;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage state: everything a visual part needs for one scroll position. Produced by Timeline.stateAt(u).

/** Scroll beats, in order. Ids match the BRIEF chapter table. */
export type BeatId = 'hero' | 'task' | 'plan' | 'lanes' | 'verify' | 'merge' | 'review' | 'bill';

export const BEAT_IDS: readonly BeatId[] = ['hero', 'task', 'plan', 'lanes', 'verify', 'merge', 'review', 'bill'];

export interface Beat {
  id: BeatId;
  /** False when the run has no event that opens this beat (e.g. no plan_mode); it then has zero scroll length. */
  present: boolean;
  /** Scroll range, 0..1, u0 <= u1. Beats tile [0, 1] in BEAT_IDS order. */
  u0: number;
  u1: number;
  /** Run-time range in seconds from the run start. hero is pinned at the run start; t0 <= t1. */
  t0: number;
  t1: number;
}

/** Lifecycle of a lot's building. Flags (scan) and reviews are tracked separately. */
export type WorkerPhase =
  | 'waiting' // not dispatched yet: the lot is only a blueprint outline
  | 'building' // first build pass in progress (`build` rising)
  | 'built' // first pass done, waiting on verify / review / merge
  | 'reworking' // resumed by the orchestrator, or a fixer branch is working on it (`rework` rising)
  | 'merging' // lifting and sliding into its block slot (`merge` rising)
  | 'merged'; // in the city block

/** Verify / review scan on a lot. */
export type ScanState =
  | 'none' // never scanned
  | 'scanning' // a scan is passing over it right now (or the last verify recorded no result)
  | 'passed' // last verify ok: show a tick-like shape
  | 'flagged'; // last verify failed: show a flag-like shape

/** Why a lot is flagged. An id, never display text; the DOM words it. */
export type FlagReason = 'tests-failed';

/** The worker's own self-check from its wrapper. 'not-ok' is mostly a denied command, not wrong code. */
export type SelfCheck = 'none' | 'ok' | 'not-ok';

export interface WorkerState {
  /** Matches a Lot slug (extra=false). */
  slug: string;
  lane: Lane;
  phase: WorkerPhase;
  /** First build pass, 0..1 (eased). Monotonic in u; stays 1 once built. */
  build: number;
  /** Current rework pass, 0..1 (eased); 0 when no rework is running or has run. Resets to 0 when a new pass starts. */
  rework: number;
  /** Lane doing the current rework (the worker's own lane for a resume, the fixer's lane for a fixer branch);
   *  null when not reworking. */
  reworkLane: Lane | null;
  /** Resumes that have happened so far (not the run total). */
  resumes: number;
  scan: ScanState;
  /** Set while scan === 'flagged', else null. */
  flag: FlagReason | null;
  /** Latest review that has finished over this lot. Reviews carry no verdict in the data; never imply one. */
  review: 'none' | 'orchestrator' | 'cross-model';
  selfCheck: SelfCheck;
  /** Merge into its block slot, 0..1 (eased). 1 = in place in the city block. */
  merge: number;
}

/** An annex lot (Lot.extra = true). */
export interface ExtraState {
  slug: string;
  lane: Lane;
  phase: WorkerPhase;
  /** 0..1 (eased). 0 until its dispatch, so the annex is empty before then. */
  build: number;
  /** 0..1 (eased): joining the block (its roads connect); it does not move. */
  merge: number;
}

export interface ActiveScan {
  /** What is being scanned. null kind = no scan right now. */
  kind: 'verify' | 'orchestrator-review' | 'cross-model-review' | null;
  /** Lot slug under the beam; null with a kind = the whole merged block (cross-model reviews have no slug). */
  target: string | null;
  /** Sweep progress over the target, 0..1. */
  progress: number;
}

export interface DroneJob {
  /** Lot slug being built or reworked. */
  slug: string;
  /** That job's progress, 0..1 (build or rework). Drones fly out near 0 and home near 1. */
  progress: number;
}

export interface DroneState {
  lane: Lane;
  /** Same as Depot.used. */
  used: boolean;
  /** Jobs this lane's drones serve right now, in lot order. Empty = drones parked in the depot. */
  jobs: DroneJob[];
}

/** Numbers for DOM counters; each counts events that have happened by this scroll position. */
export interface StageCounters {
  /** Dispatches, originals and extras (fixers included). */
  dispatched: number;
  /** Distinct lots whose first build pass finished. */
  built: number;
  /** Lots fully merged (worker branches, plus extras; a worker merged through a fixer counts once). */
  merged: number;
  /** Lots in phase 'merging' right now (lifting and sliding, not yet in place). Not monotonic: drops as they land. */
  merging: number;
  /** Review events of either kind. */
  reviewsDone: number;
  /** Cross-model review events. */
  crossReviewsDone: number;
  /** Resume events. */
  resumes: number;
}

export interface StageState {
  /** Scroll progress this state was computed for, 0..1. */
  u: number;
  /** Run seconds shown at this scroll position. Monotonic in u. */
  runTime: number;
  beat: BeatId;
  /** Progress through the current beat's scroll range, 0..1. */
  beatProgress: number;
  /** Blueprint line draw, 0..1 (plan_mode -> plan_approved). */
  blueprint: number;
  /** Plot splitting into lots, 0..1 (plan_approved -> first dispatch). */
  split: number;
  planApproved: boolean;
  /** How the plan was approved, from the run; null when not recorded. */
  planApproval: 'automatic' | 'human' | null;
  /** One per original worker, in layout lot order. */
  workers: WorkerState[];
  /** One per annex lot, in layout order. */
  extras: ExtraState[];
  activeScan: ActiveScan;
  /** One per entry of LANES, in that order. */
  drones: DroneState[];
  /** Mean merge progress over all lots, 0..1: drives roads appearing. */
  mergeAll: number;
  /** The bill beat's progress, 0..1 (city recedes, DOM counters). */
  bill: number;
  counters: StageCounters;
}

export interface Timeline {
  beats: Beat[];
  /** Run seconds for scroll progress u (clamped to 0..1). Monotonic, piecewise linear. */
  runTimeAt(u: number): number;
  /** Pure: the same u always gives an equal state. Allocates a fresh object; call once per frame. */
  stateAt(u: number): StageState;
}

// ---------------------------------------------------------------------------------------------------------------
// Visual parts

/** Colours as CSS hex strings ('#rrggbb'), accepted by THREE.Color. Read from src/styles/tokens.css by scene.ts. */
export interface CityPalette {
  paper: string;
  ink: string;
  line: string;
  lightWarm: string;
  laneAgy: string;
  laneOpencode: string;
  ok: string;
  fail: string;
}

/** One visual module. update() runs every frame: cheap, allocation-free, no DOM, no scroll reads. */
export interface CityPart {
  object: Object3D;
  /** `dt` = seconds since the last frame (for idle motion only; state drives everything else). */
  update(state: StageState, dt: number): void;
  /** Optional: screen scale (px per metre at the look-at point) once per frame, so a part can drop fine detail that reads as noise. */
  setDetail?(pxPerMetre: number): void;
  /** Free every geometry, material and texture the part created. */
  dispose(): void;
}

/** Factory signatures every visual module exports (palette is passed so parts never read CSS themselves). */
export type CreateBlueprint = (layout: LotLayout, palette: CityPalette) => CityPart;
export type CreateBuildings = (layout: LotLayout, palette: CityPalette) => CityPart;
export type CreateDrones = (layout: LotLayout, palette: CityPalette, kit?: Kit | null) => CityPart;
export type CreateScan = (layout: LotLayout, palette: CityPalette) => CityPart;
export type CreateMerge = (layout: LotLayout, palette: CityPalette) => CityPart;

/** Anything that accepts post passes, e.g. three's EffectComposer. */
export interface PassHost {
  addPass(pass: unknown): void;
  removePass?(pass: unknown): void;
}

/** Tilt-shift blur band (high tier only). */
export interface TiltShift {
  install(host: PassHost): void;
  /** Detach passes from their host without disposing (scene drops the composer on tier change). */
  uninstall(): void;
  /** Drawing-buffer size in pixels. */
  setSize(width: number, height: number): void;
  /** Disabled = passes are skipped entirely (no cost). */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
export type CreateTiltShift = () => TiltShift;
