// Integration timings and mappings (Phase 5). NOT look values: the locked look lives in config.ts and is read, never edited.

/** Camera used to draw the finale swarm (world.ts) and to place the DOM copy button beside the assembled text. */
export const SWARM_CAM = { fov: 40, z: 24 } as const;

export const motion = {
  /** Scroll length of each chapter runway, in viewport heights. Every runway holds one fixed, viewport-tall scene that only fades. */
  runway: { intro: 100, hive: 300, cells: 1500, proof: 150, finale: 550 }, // finale: 400 for the swarm and the command, plus LOOP_VH of homecoming below
  /** The scroll lengths camera-path.ts solves its speed profile for (the lengths before the walk). The layout lengths above may differ (Cells is longer for the walk); the camera's
   *  scroll-to-position mapping is solved on THESE, so every chapter keeps exactly the camera it had, and a longer Cells only spreads its progress over more scroll. */
  mapRunway: { intro: 100, hive: 300, cells: 300, proof: 150, finale: 400 },
  /** The hive packet is scrubbed by scroll across the pinned window; these are the seconds of route time it spans. */
  hive: { holdSec: 1.6, captionBlend: 0.05 },
  hud: { stagger: 0.035 },
  intro: {
    durationMs: 3600,
    titleStartMs: 0,
    titleMs: 1500,
    taglineStartMs: 800,
    taglineMs: 1900,
  },
  packet: {
    meanSpeed: 4.2, // world units per second averaged over a leg (a leg eases in and out, so its peak is 1.875x this)
    minLegSec: 0.7, // shortest a leg may last
    coreHoldSec: 1.1, // "classified": the comet holds at the core while the scanning ring is engraved
    holdSec: 0.4, // hold at each stop on a card route
    specHoldSec: 0.35, // hold at the specialist before the fan-out
    fadeSec: 0.6,
    entryHold: 0.15, // scroll-scrubbed route: seconds of stillness before the comet starts
    hiveHoldSec: 1.2, // the gates hold at the end of the scrubbed route
    ripple: { speed: 2.4, sec: 0.9, width: 0.055 }, // arrival ripple: world units/s across the surface, lifetime, line width
    scan: { radius: 0.62, width: 0.06, fade: 0.4 }, // the scanning ring: fraction of the panel half-width, line width, fade-out seconds
  },
  hilite: { ratePerSec: 9, strike: 0.8 }, // panel lift/brighten smoothing, and how strongly a comet landing lifts a panel
  camera: {
    focusRatePerSec: 4,
    hoverBias: 0.3, // keyboard focus only: how far the look-at target moves toward the focused cell (pointer hover never moves the camera)
    routeBias: 0.5, // ... toward a replaying comet
    hiveBias: 0.22, // the hive look-at leans this far toward the comet head while it is on screen
    routeOverview: 0.9, // a replaying route pulls the camera out to the full-lattice view
    routeDrop: 0.2,
  },
  /** The Cells -> Proof dissolve, dim and canvas recede are ONE smoothstep over a window that straddles the chapter boundary:
   *  from `fromVh` scroll before it (the tail of Cells) to `toVh` after it (the head of Proof). camera-path.ts centres its slow-down on it. */
  proof: { fromVh: -25, toVh: 65, canvasOpacity: 0.5 },
  finale: {
    // chapterProgress of the part before the homecoming (the first 360vh of the scroll, which is `q` in finale.ts). The lattice breaks up while the scene is still sliding in, the swarm
    // assembles by 0.5, then the assembled command holds (no fade back: nothing sits behind it any more).
    breakEnd: 0.16, // lattice fully gone
    swarmInStart: 0.02,
    swarmInEnd: 0.14,
    opacityStart: 0.05, // the canvas comes back up from the proof level as the lattice thins out
    opacityEnd: 0.2,
    attractStart: 0.1,
    attractEnd: 0.5,
    copyStart: 0.52, // the copy button and the chips appear only after the command has formed
    copyEnd: 0.58,
    chipsStart: 0.58,
    chipsEnd: 0.82,
    textLift: 0, // the assembled command holds centre screen
  },
  /** The globe's slow spin about its own axis. It turns in the intro, Proof and finale and parks (facing home, so the framing, comet routes and fly-over
   *  are exactly the un-spun ones) in the hive and the fly-over. The weight 0..1 eases over the existing chapter-boundary windows (see spinWeight). */
  spin: {
    turnSec: 210, // seconds per full turn at full weight (about 3.5 minutes)
    introFrom: 0.25, // intro chapterProgress at which the globe starts easing home; it is home by the hive boundary (progress 1)
  },
  /** The moon's own motion (the spin rate and drift size are look.cell.moonTurnSec / moonDrift). It parks with the same weight as the globe's spin (spinWeight). */
  moon: {
    driftSec: 50, // seconds per lap of the drift ellipse
  },
  walkAuto: { diveSec: 8, tailSec: 10, easeSec: 0.4 }, // the walk plays itself (scroll.ts): seconds for the dive in, for the rise out and the pull-back to the end of Cells (the route's own time is walkCfg.rate), and the ease of start/pause/resume
  probe: { ms: 1000, warmupFrames: 10, minFrames: 6, stepDownBelow: 45, fallbackBelow: 30 },
} as const;

const smooth3 = (t: number) => t * t * (3 - 2 * t);
/**
 * The page loops: Lenis wraps the scroll (scroll.ts), so the last LOOP_VH of the finale is a homecoming that ends on exactly the frame the intro opens with. The swarm lets go
 * and fades, the lattice regrows from the core, the camera swings back to the intro's rest pose and the intro's wordmark fades in. Finale chapterProgress runs 0..loopFrom
 * on the old finale, loopFrom..1 on the homecoming. (The last trigger spans runway - 40vh: it ends at "bottom bottom".)
 */
export const LOOP_VH = 150;
export const loopFrom = 1 - LOOP_VH / (motion.runway.finale - 40);
/** progress through the homecoming, 0..1, for finale chapterProgress p */
export const loopT = (p: number): number => Math.min(1, Math.max(0, (p - loopFrom) / (1 - loopFrom)));
/** the camera's weight (0 = finale view, 1 = the intro's rest pose) for homecoming progress b; flat at both ends so the seam has no kink */
export const loopCamera = (b: number): number => smooth3(Math.min(1, Math.max(0, (b - 0.08) / 0.92)));
/** Spin weight 0..1 for chapter `chapter` at chapterProgress p: 1 = turning freely, 0 = parked at home.
 *  Intro: eases from 1 to 0 over the tail of its runway. Hive and Cells: 0. Cells tail -> Proof: rises with the dissolve window. Proof, finale: 1. */
export function spinWeight(chapter: number, p: number): number {
  if (chapter === 0) { const f = motion.spin.introFrom; return 1 - smooth3(Math.min(1, Math.max(0, (p - f) / (1 - f)))); }
  if (chapter === 1) return 0;
  return recedeMix(chapter, p);
}
/** The shared dissolve ease, 0..1, for chapter 2 (Cells, its tail) or 3 (Proof, its head) at chapterProgress p; 0 or 1 elsewhere. */
export function dissolveMix(chapter: number, p: number): number {
  const { fromVh, toVh } = motion.proof;
  const vh = chapter === 2 ? (p - 1) * motion.runway.cells : chapter === 3 ? p * motion.runway.proof : chapter < 2 ? -Infinity : Infinity;
  return smooth3(Math.min(1, Math.max(0, (vh - fromVh) / (toVh - fromVh))));
}

/** The walk (Cells chapter): where the camera is on the ground. The ramp values are provisional (tuned in the story integration): it dives in over
 *  chapterProgress inFrom..inTo and rises out over outFrom..outTo, finishing before the Cells -> Proof dissolve window opens (p = 0.917). */
export const walkRamp = { inFrom: 0.06, inTo: 0.2, outFrom: 0.8, outTo: 0.9 } as const;
/** Walk weight 0..1 for chapter `chapter` at chapterProgress p: 0 = on the spline fly-over path, 1 = walking. Modelled on spinWeight; the pistons park with it. */
export function walkWeight(chapter: number, p: number): number {
  if (chapter !== 2) return 0;
  const r = (a: number, b: number) => smooth3(Math.min(1, Math.max(0, (p - a) / (b - a))));
  return r(walkRamp.inFrom, walkRamp.inTo) * (1 - r(walkRamp.outFrom, walkRamp.outTo));
}

/** The walker (provisional values, tuned in the Phase 4 review): eye height above the local ground, vertical FOV, pitch below the horizon, near plane,
 *  and where in the Cells chapter progress the route runs from its first stand point (uFrom) to its last (uTo). */
export const walkCfg = {
  eye: 0.3, fov: 75, pitchDeg: 15, near: 0.03, uFrom: 0.2, uTo: 0.82, detail: 1, coreDim: 0.9, fogNear: 0.6, fogFar: 3,
  /** The tour's pace. The route parameter runs at `rate` route units per second under autoplay (scroll.ts is told the route's length and sets its speed from this), so every duration below is
   *  in seconds: the walker holds at a tower for dwellSec (coreSec at the core, where the task is classified and approved), a street takes legStretch route units per world unit walked (so a street of 5.6 units takes
   *  5.6 x 3 / 8 = 2.1 s), and a turn to face a tower or on to the next street takes turnSecQuarter seconds per 90 degrees (between turnMinSec and turnMaxSec). */
  rate: 8, dwellSec: 4, coreSec: 6, legStretch: 3, turnSecQuarter: 1.2, turnMinSec: 0.8, turnMaxSec: 2.8,
  /** while it faces a tower the view zooms to holdFov and tips up so the cap sits capY of the way from the centre to the top edge of the frame (never above capUpMax degrees);
   *  zoomSec is how long that zoom and tip take to ease in and out (a gaussian over the facing weight, in seconds) */
  /** the task's comet (journey-comet.ts): it leaves a tower this long before the walker's hold ends and lands on the next cap this long before the walker stops */
  cometLeadSec: 1, cometArriveSec: 1, cometHover: 2.4, gazeYawDeg: 40, // (hover: world units above the cap's centre while it holds; the walker looks up at the cap, so lower is hidden behind the tower's near edge)
  holdFov: 62, capY: 0.3, capUpMax: 60, zoomSec: 0.7,
  /** the walker stops this many world units short of the cell next to a tower, so the whole pillar is in frame (walk.ts) */
  holdBack: 2.2,
  /** seconds over which the street heading is rounded (the camera does not whip round cell corners) */
  streetSec: 1.4,
  /** how much taller the agent towers stand under the walker (world units, eased in with the walk weight; honeycomb.ts) */
  towerGrow: 0.6,
  /** handheld sway: vertical bob and side shift in world units, roll in degrees, steps per second at the mean autoplay leg speed (rate / legStretch world units per second) */
  sway: { bob: 0.008, side: 0.005, rollDeg: 0.4, hz: 1.8 },
} as const;
/** Route parameter 0..1 for Cells chapter progress p. */
export const walkUOf = (p: number): number => Math.min(1, Math.max(0, (p - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom)));

/**
 * The pull-back from the walk into the Proof view. No dissolve: the rise carries straight on, and the dimming, the canvas receding and the globe's spin
 * coming back all run on this ONE smooth ease (0..1), from the start of the rise (Cells progress walkRamp.outFrom) to `motion.proof.toVh` into Proof.
 * Chapter 2 (Cells) at progress p, chapter 3 (Proof); 0 before and 1 after.
 */
export function recedeMix(chapter: number, p: number): number {
  const from = walkRamp.outFrom * motion.runway.cells, to = motion.runway.cells + motion.proof.toVh;
  const vh = chapter === 2 ? p * motion.runway.cells : chapter === 3 ? motion.runway.cells + p * motion.runway.proof : chapter < 2 ? -Infinity : Infinity;
  return smooth3(Math.min(1, Math.max(0, (vh - from) / (to - from))));
}
