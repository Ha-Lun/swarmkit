// Integration timings and mappings (Phase 5). NOT look values: the locked look lives in config.ts and is read, never edited.

/** Camera used to draw the finale swarm (world.ts) and to place the DOM copy button beside the assembled text. */
export const SWARM_CAM = { fov: 40, z: 24 } as const;

export const motion = {
  /** Scroll length of each chapter runway, in viewport heights. Every runway holds one fixed, viewport-tall scene that only fades. */
  runway: { intro: 100, hive: 300, cells: 300, proof: 150, finale: 400 },
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
  hilite: { ratePerSec: 9, strike: 0.6 }, // panel lift/brighten smoothing, and how strongly a comet landing lifts a panel
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
    // chapterProgress on a 400vh runway. The lattice breaks up while the scene is still sliding in, the swarm
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
  probe: { ms: 1000, warmupFrames: 10, minFrames: 6, stepDownBelow: 45, fallbackBelow: 30 },
} as const;

const smooth3 = (t: number) => t * t * (3 - 2 * t);
/** Spin weight 0..1 for chapter `chapter` at chapterProgress p: 1 = turning freely, 0 = parked at home.
 *  Intro: eases from 1 to 0 over the tail of its runway. Hive and Cells: 0. Cells tail -> Proof: rises with the dissolve window. Proof, finale: 1. */
export function spinWeight(chapter: number, p: number): number {
  if (chapter === 0) { const f = motion.spin.introFrom; return 1 - smooth3(Math.min(1, Math.max(0, (p - f) / (1 - f)))); }
  if (chapter === 1) return 0;
  return dissolveMix(chapter, p);
}
/** The shared dissolve ease, 0..1, for chapter 2 (Cells, its tail) or 3 (Proof, its head) at chapterProgress p; 0 or 1 elsewhere. */
export function dissolveMix(chapter: number, p: number): number {
  const { fromVh, toVh } = motion.proof;
  const vh = chapter === 2 ? (p - 1) * motion.runway.cells : chapter === 3 ? p * motion.runway.proof : chapter < 2 ? -Infinity : Infinity;
  return smooth3(Math.min(1, Math.max(0, (vh - fromVh) / (toVh - fromVh))));
}
