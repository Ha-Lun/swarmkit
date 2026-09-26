// Look uniforms as data. Round 9 adds agent towers (towerLift, towerStep, capGloss, capBevel). Round 8 (iron-blue palette locked; basalt columns: stepped heights, flat matte tops, dark striated sides, polished agent facets, hard-edged comet, no glow): the human unlocked cell, light and packet for this round only;
// they re-lock after the verdict. The /lookdev sliders mutate these objects in memory only (nothing is persisted), so a reload restores the values here.

export type Tier = 'high' | 'medium';

/** Circumradius of the unit prism geometry. The seam is not baked in: every panel is scaled so the gap to its neighbours is `look.cell.seam` wide. */
export const CELL_RADIUS = 1;
/** Prisms start this far below the surface; the (dark, matte) seam floor sits half of it below the surface. */
export const SINK = 0.12;

// Fallback copy of the colour tokens in src/styles/tokens.css. readPalette() prefers the CSS values.
const PALETTE_FALLBACK = { ink: '#080b10', ink2: '#121824', wax: '#9aa6b4', waxDim: '#46505e', text: '#d9dee5' };
export type Palette = typeof PALETTE_FALLBACK;

export function readPalette(): Palette {
  if (typeof document === 'undefined') return PALETTE_FALLBACK;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    ink: get('--ink', PALETTE_FALLBACK.ink),
    ink2: get('--ink-2', PALETTE_FALLBACK.ink2),
    wax: get('--wax', PALETTE_FALLBACK.wax),
    waxDim: get('--wax-dim', PALETTE_FALLBACK.waxDim),
    text: get('--text', PALETTE_FALLBACK.text),
  };
}

/** Accent: violet chosen in round 1 (human). Candidates stay on /lookdev for comparison. */
export const accentCandidates = [
  { name: 'cyan', hex: '#4fd8e8' },
  { name: 'violet', hex: '#a98bff' },
  { name: 'coral', hex: '#ff6a55' },
] as const;

export const look = {
  cell: {
    // geometry: every panel sits at the same radius; relief and seam are world units (a cell is about 1.7 across)
    relief: 0.05, // how far the lowest panel stands above the sphere (about 3% of a cell)
    elevation: 0.85, // terrain: how much taller the highest resting column is than the lowest, world units (clamped so relief + elevation <= 0.9)
    steps: 5, // basalt: number of distinct column heights (heights snap to these levels)
    terrainScale: 1.7, // terrain feature size: noise frequency over the unit sphere (higher = more, smaller ranges)
    // reactor pistons: filler columns drive out and retract; agent columns stay on a steady shelf
    stroke: 0.5, // how far a rod drives out beyond its resting height, world units (a rod throws half or the full stroke)
    pistonSpeed: 9, // seconds per rod cycle (hold low, drive out, hold high, retract): larger is slower
    activity: 0.2, // share of a cycle a rod spends moving (the rest it holds): lower = fewer rods moving at once
    wave: 0.6, // 0 = every rod on its own random timing, 1 = rods ordered by a slow wave round the globe (fire in sequences)
    seam: 0.05, // width of the engraved seam between panels, constant over the whole globe
    bevel: 0.025, // hairline rounded edge on the panel top, so the seam stays crisp
    lift: 0.07, // world units a hovered/focused (or comet-struck) panel rises
    // material
    roughness: 0.6, // matte stone; the lights give it a gentle satin highlight
    sheen: 0.3, // satin lift at grazing angles
    envIntensity: 0.25, // procedural studio reflection (high tier only)
    // basalt (procedural, from the five palette tokens): flat matte tops, dark striated sides
    sideDark: 0.75, // how dark the column walls are (0 = wax-dim stone, 1 = ink-2)
    grain: 0.2, // fine grain on the tops, high tier only (faded by pixel footprint)
    mottle: 0.2, // slow blotchy tone variation of the tops
    tone: 0.04, // per-column brightness variation
    // agent towers: stand fixed above every rod, capped with a polished pale cut (no inlay, no ring, no accent)
    towerLift: 0.25, // world units of clear air between the highest a rod can reach and the shortest tower (the gate tier)
    towerStep: 0.1, // extra height per tier: core is 3 steps above the gate tier, t1 2, domain 1
    capGloss: 0.75, // how polished the cap is: the cap's roughness is scaled by (1 - capGloss); the cap also reflects the studio harder
    capBevel: 3, // the cap's chamfer width as a multiple of the filler bevel
    agentTone: 0.35, // how much lighter the cap stone is than filler
    hover: 0.45, // tone brightening of a hovered/focused panel
  },
  light: {
    key: 1.7, // directional key intensity
    hemi: 0.08,
    ambient: 0.05,
    kicker: 0.5, // rim light from behind the globe
    sweep: 0.6, // 0 = key rides with the camera, 1 = fixed in the world; between, highlights travel as the camera orbits
    keyElevation: 42, // degrees
  },
  packet: {
    // the comet: small hard head, tapering tail that grows with speed, a few shed sparks. Nothing additive.
    headSize: 13, // px at 1080p
    headBrightness: 1.0,
    tailMin: 0.5, // world units of tail at rest
    tailGain: 0.55, // extra tail per (unit/s) of visible speed
    tailMax: 3.4,
    tailWidth: 0.17, // world units at the head
    tailFade: 1.5, // darkening exponent toward the tail end
    sparks: 0.8, // emission strength (0 = none)
    height: 0.16, // low constant lift above the panel tops
  },
  dissolve: {
    hexScale: 1.0, // multiplier on the on-screen lattice cell size (1 = native)
    spread: 0.35, // how long each hex takes relative to the whole transition
    noise: 0.12, // 0 = clean radial wavefront, 1 = random per hex
    edge: 1.25, // edge softness in px
  },
  particles: {
    countHigh: 16384,
    countMedium: 4096,
    curlScale: 0.35,
    curlStrength: 5.0,
    curlSpeed: 0.15,
    cohesion: 0.3,
    attract: 0.0, // 0..1, stand-in for chapterProgress
    attractStrength: 9.0,
    damping: 2.2,
    maxSpeed: 8.0,
    size: 2.2, // px at 1080p
    opacity: 0.45,
    textWidth: 16, // world units the target text spans
    spawnRadius: 7,
  },
  post: {
    chromaticAberration: 0.007, // RGB split, grows with distance from centre
    grain: 0.02,
    grainSize: 1.5, // px
  },
};

export type Look = typeof look;

/** [min, max, step] for the lookdev sliders. Keys mirror `look`. */
export const ranges: { [G in keyof Look]?: { [K in keyof Look[G]]?: [number, number, number] } } = {
  cell: {
    relief: [0.01, 0.15, 0.005], elevation: [0, 0.85, 0.005], steps: [2, 10, 1], terrainScale: [0.5, 4, 0.05], stroke: [0, 0.8, 0.01], pistonSpeed: [3, 30, 0.5], activity: [0.05, 0.6, 0.01], wave: [0, 1, 0.01], seam: [0.02, 0.25, 0.005], bevel: [0, 0.06, 0.0025], lift: [0, 0.3, 0.005],
    roughness: [0.15, 1, 0.01], sheen: [0, 1.5, 0.01], envIntensity: [0, 1.5, 0.01],
    sideDark: [0, 1, 0.01], grain: [0, 1, 0.01], mottle: [0, 1, 0.01], tone: [0, 0.2, 0.005],
    towerLift: [0, 1, 0.01], towerStep: [0, 0.3, 0.005], capGloss: [0, 0.95, 0.01], capBevel: [1, 6, 0.1],
    agentTone: [0, 0.6, 0.01], hover: [0, 1.2, 0.01],
  },
  light: { key: [0, 4, 0.05], hemi: [0, 2, 0.02], ambient: [0, 1, 0.01], kicker: [0, 3, 0.05], sweep: [0, 1, 0.01], keyElevation: [5, 80, 1] },
  packet: {
    headSize: [3, 24, 0.5], headBrightness: [0.2, 2, 0.01], tailMin: [0, 2, 0.02], tailGain: [0, 2, 0.01], tailMax: [0.5, 8, 0.05],
    tailWidth: [0.02, 0.4, 0.005], tailFade: [0.3, 4, 0.05], sparks: [0, 2, 0.05], height: [0.05, 0.8, 0.01],
  },
  dissolve: { hexScale: [0.4, 4, 0.05], spread: [0.05, 0.9, 0.01], noise: [0, 1, 0.01], edge: [0.5, 6, 0.05] },
  particles: {
    curlScale: [0.05, 1.5, 0.01], curlStrength: [0, 15, 0.1], curlSpeed: [0, 1, 0.01], cohesion: [0, 1, 0.01],
    attract: [0, 1, 0.005], attractStrength: [0, 30, 0.1], damping: [0.2, 8, 0.1], maxSpeed: [1, 20, 0.1],
    size: [0.5, 8, 0.1], opacity: [0.05, 1, 0.01], textWidth: [6, 26, 0.5], spawnRadius: [2, 20, 0.5],
  },
  post: { chromaticAberration: [0, 0.05, 0.001], grain: [0, 0.12, 0.001], grainSize: [1, 4, 0.1] },
};
