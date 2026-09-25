// Integration timings and mappings (Phase 5). NOT look values: the locked look lives in config.ts and is read, never edited.
export const motion = {
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
    hoverBias: 0.6, // how far the look-at target moves toward the hovered cell
    routeBias: 0.5, // ... toward a replaying packet
    routeOverview: 0.9, // a replaying route pulls the camera out to the full-lattice view
    routeDrop: 0.2,
  },
  proof: { dissolveEnd: 0.22, dimEnd: 0.55, canvasOpacity: 0.5 },
  finale: {
    breakEnd: 0.2, // lattice fully gone
    swarmInStart: 0.03,
    swarmInEnd: 0.2,
    opacityStart: 0.08, // the canvas comes back up from the proof level as the lattice thins out
    opacityEnd: 0.22,
    attractStart: 0.08,
    attractEnd: 0.35,
    fadeBackStart: 0.5, // swarm recedes so the install copy stays legible
    fadeBackEnd: 0.8,
    fadeBackTo: 0.35,
    textLift: 0.26, // fraction of viewport height the assembled text sits above centre (top of the install section)
  },
  probe: { ms: 1000, warmupFrames: 10, minFrames: 6, stepDownBelow: 45, fallbackBelow: 30 },
} as const;
