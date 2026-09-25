// Integration timings and mappings (Phase 5). NOT look values: the locked look lives in config.ts and is read, never edited.

/** Camera used to draw the finale swarm (world.ts) and to place the DOM copy button beside the assembled text. */
export const SWARM_CAM = { fov: 40, z: 24 } as const;

export const motion = {
  /** Scroll length of each chapter runway, in viewport heights. Every runway holds one sticky, viewport-tall scene. */
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
    unitsPerSec: 4.5, // world units per second along a route
    dwellSec: 0.45, // pause at each stop on a card route
    coreDwellSec: 0.7, // "classified" pause on the hive route
    fadeSec: 0.6,
    arcLift: 0.6, // extra height of a hop between cells
    arcLiftPerUnit: 0.05,
    entryHeight: 4,
    hiveHoldSec: 1.2,
    hiveGapSec: 1.6,
  },
  glow: { boost: 0.8, lift: 1, ratePerSec: 9 },
  camera: {
    focusRatePerSec: 4,
    hoverBias: 0.3, // keyboard focus only: how far the look-at target moves toward the focused cell (pointer hover never moves the camera)
    routeBias: 0.5, // ... toward a replaying packet
    routeOverview: 0.9, // a replaying route pulls the camera out to the full-lattice view
    routeDrop: 0.2,
  },
  proof: { dissolveEnd: 0.28, dimEnd: 0.6, canvasOpacity: 0.5 },
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
  probe: { ms: 1000, warmupFrames: 10, minFrames: 6, stepDownBelow: 45, fallbackBelow: 30 },
} as const;
