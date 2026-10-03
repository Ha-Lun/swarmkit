// Integration timings and mappings (Phase 5). NOT look values: the locked look lives in config.ts and is read, never edited.

/** Camera used to draw the finale swarm (world.ts) and to place the DOM copy button beside the assembled text. */
export const SWARM_CAM = { fov: 40, z: 24 } as const;

export const motion = {
  /** Scroll length of each chapter runway, in viewport heights. Every runway holds one fixed, viewport-tall scene that only fades. */
  runway: { intro: 100, hive: 150, cells: 1000, proof: 150, finale: 550 }, // finale: 400 for the swarm and the command, plus LOOP_VH of homecoming below
  /** The scroll lengths camera-path.ts solves its speed profile for (the lengths before the walk). The layout lengths above may differ (Cells is longer for the walk); the camera's
   *  scroll-to-position mapping is solved on THESE, so every chapter keeps exactly the camera it had, and a longer Cells only spreads its progress over more scroll. */
  mapRunway: { intro: 100, hive: 150, cells: 300, proof: 150, finale: 400 },
  hud: { stagger: 0.035 },
  intro: {
    durationMs: 3600,
    titleStartMs: 0,
    titleMs: 1500,
    taglineStartMs: 800,
    taglineMs: 1900,
  },
  packet: {
    meanSpeed: 7, // world units per second averaged over a leg (a leg eases in and out, so its peak is 1.875x this)
    minLegSec: 0.7, // shortest a leg may last
    holdSec: 0.4, // how long a comet's landing lifts the tower (the pulse)
    ripple: { speed: 2.4, sec: 0.9, width: 0.055 }, // arrival ripple: world units/s across the surface, lifetime, line width
    scan: { radius: 0.62, width: 0.06, fade: 0.4 }, // the scanning ring: fraction of the panel half-width, line width, fade-out seconds
  },
  hilite: { ratePerSec: 9, strike: 0.8 }, // panel lift/brighten smoothing, and how strongly a comet landing lifts a panel
  camera: {
    focusRatePerSec: 4,
    hoverBias: 0.3, // keyboard focus only: how far the look-at target moves toward the focused cell (pointer hover never moves the camera)
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
  /** The page plays itself once started (scroll.ts): seconds each chapter takes under autoplay (Cells has its own pacing below: the dive, the journey in seconds, the tail), and the ease of start/pause/resume. */
  autoplay: { introSec: 2.5, hiveSec: 6, proofSec: 7, finaleSec: 11, loopSec: 4, easeSec: 0.4 },
  walkAuto: { diveSec: 3.1, tailSec: 9.5, tailSecBare: 6.5 }, // the walk plays itself (scroll.ts): seconds for the dive in, for the rise out and the pull-back to the end of Cells (tailSecBare for a task with no gate: nothing to show there), the route's own time is walkCfg.rate
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

/** The low orbit (Cells chapter): where the camera follows the comet. The ramp values are provisional (tuned in the story integration): it dives in over
 *  chapterProgress inFrom..inTo and rises out over outFrom..outTo. The rise starts a little after the route's end (uTo): the autoplay speed of a short route is far above the tail's and eases
 *  down over about a second (scroll.ts), and the rise must not be swept past in that time. */
export const walkRamp = { inFrom: 0.03, inTo: 0.2, outFrom: 0.82, outTo: 0.915 } as const;
/** Walk weight 0..1 for chapter `chapter` at chapterProgress p: 0 = on the spline fly-over path, 1 = walking. Modelled on spinWeight; the pistons park with it. */
export function walkWeight(chapter: number, p: number): number {
  if (chapter !== 2) return 0;
  const r = (a: number, b: number) => smooth3(Math.min(1, Math.max(0, (p - a) / (b - a))));
  return r(walkRamp.inFrom, walkRamp.inTo) * (1 - r(walkRamp.outFrom, walkRamp.outTo));
}

/** The follow camera (provisional values): the low orbit that follows the task's comet (follow.ts). `fov`, `near`; the Cells chapter progress the journey runs over, from its first moment (uFrom) to its
 *  last (uTo); and the look of the view (detail, core glow dim, horizon fog as multiples of the horizon distance). */
export const walkCfg = {
  fov: 55, near: 0.1, uFrom: 0.14, uTo: 0.78, detail: 1, coreDim: 0.9, fogNear: 0.6, fogFar: 3,
  /** The journey's pace. The route parameter runs at `rate` route units per second under autoplay (scroll.ts is told the route's length and sets its speed from this), so every duration is in
   *  seconds: the comet holds at a tower for dwellSec (coreSec at the core, where the task is classified and approved); its legs take as long as they take at the comet's own speed. */
  rate: 8, dwellSec: 1.8, coreSec: 2.2, beatSec: 2.2, minSec: 6, entrySec: 2.3,
  /** The camera's viewpoint at a stop: `back` world units behind the comet's arrival direction and `up` above the cap; the camera path stays `clearMargin` above the tallest column's reach
   *  and trails the comet by `lagSec` seconds. */
  back: 4, up: 2.2, clearMargin: 0.5, lagSec: 0.45,
  /** ... and at the entry (the comet waiting outside the globe): `entryBack` world units behind it, away from the globe, and `entryUp` outward. `entrySec` is the shortest the entry leg may take. */
  entryBack: 5, entryUp: 1.5,
  /** On the moon the camera orbits it `moonOrbit` moon radii from its centre, leaning `moonFace` towards the moon's face, aiming `moonAim` of the way from the comet to the moon's centre; a hop
   *  on the moon takes at least `moonLegSec` (they are short, and the orbit turns with them); the leg across lifts `transferLift` world units off each body and takes at least `transferSec`. */
  moonOrbit: 3.4, moonFace: 1.6, moonLegSec: 1.4, moonAim: 0.6, transferLift: 4, transferSec: 2.6,
} as const;
/**
 * The aerial (Cells chapter progress): once the walker has made its last stop the camera rises to the whole-globe view (the end of the Hive's camera path), the gates the task triggers
 * receive their comets in parallel (they leave the last stop together at `fanFrom` and land together at `fanTo`), and the camera comes back onto the spline for the Proof pull-back over
 * `overviewOut`. The dim and the canvas recede (recedeMix) start only after the gates have landed, so they are seen undimmed.
 */
export const aerial = { overviewIn: [0.82, 0.915], overviewOut: [0.945, 1], captionFrom: 0.84, doneFrom: 0.94, fanFrom: 0.88, fanTo: 0.93, handOff: 0.012, gateIn: 0.008,
  /** the gate view: the camera frames the last stop and the gate towers together, from the side they face, `fit` x their spread away (between `min` and `max` globe radii above the surface) */
  view: { fit: 2.7, min: 2.2, max: 4 },
  /** the comets are drawn this much larger, at most, at the whole-globe distance of the split (so they read as comets and not dots) */
  boost: 2.5, gateFadeOut: [0.955, 0.985], recedeFrom: 0.955 } as const;

/** Route parameter 0..1 for Cells chapter progress p. */
export const walkUOf = (p: number): number => Math.min(1, Math.max(0, (p - walkCfg.uFrom) / (walkCfg.uTo - walkCfg.uFrom)));

/**
 * The pull-back from the walk into the Proof view. No dissolve: the rise carries straight on, and the dimming, the canvas receding and the globe's spin
 * coming back all run on this ONE smooth ease (0..1), from the start of the rise (Cells progress walkRamp.outFrom) to `motion.proof.toVh` into Proof.
 * Chapter 2 (Cells) at progress p, chapter 3 (Proof); 0 before and 1 after.
 */
export function recedeMix(chapter: number, p: number): number {
  const from = aerial.recedeFrom * motion.runway.cells, to = motion.runway.cells + motion.proof.toVh;
  const vh = chapter === 2 ? p * motion.runway.cells : chapter === 3 ? motion.runway.cells + p * motion.runway.proof : chapter < 2 ? -Infinity : Infinity;
  return smooth3(Math.min(1, Math.max(0, (vh - from) / (to - from))));
}
