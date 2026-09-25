// Look uniforms as data. Round 4 (pearlescent ceramic globe): the human unlocked cell, light, halo and dust for this round only;
// they re-lock after the verdict. The /lookdev sliders mutate these objects in memory only (nothing is persisted), so a reload restores the values here.

export type Tier = 'high' | 'medium';

/** Prism radius of one lattice cell; <1 leaves a visible seam (lattice circumradius is 1). */
export const CELL_RADIUS = 0.958;
/** Prisms start this far below the surface so seams never show a gap; the seam floor sits half of it below the surface. */
export const SINK = 0.12;

// Fallback copy of the colour tokens in src/styles/tokens.css. readPalette() prefers the CSS values.
const PALETTE_FALLBACK = { ink: '#0c1016', ink2: '#151b24', wax: '#b9aa88', waxDim: '#6e6653', text: '#d8d5cb' };
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
    rim: 0.4, // fresnel rim intensity (softened in round 4)
    rimPower: 2.6, // higher = thinner rim
    thickness: 0.25, // warm bleed at cell edges (high tier only)
    density: 0.15, // darkening of the dense centre (high tier only)
    core: 0.4, // emissive core strength, agent cells only
    coreRadius: 0.62, // core extent in cell-radius units (<1 stays inside the cell)
    roughness: 0.36, // satin: low enough for a soft wide highlight, high enough for no sparkle
    lift: 0.35, // world units a hovered/focused cell rises
    bevel: 0.1, // world units: rounded edge on top of each cell, so silhouettes catch light
    dome: 0.7, // how far the top face's shading leans outward at the cell edge (a soft pillow, not a flat puck)
    relief: 0.75, // multiplier on the (already low) cell extrusion
    sheen: 0.55, // satin sheen at grazing angles, driven by the key and kicker lights
    pearl: 0.6, // pearl colour shift toward each cell's edge
    pearlHorizon: 0.8, // pearl colour shift toward the horizon
    seamGlow: 0.8, // soft warm glow in the engraved seams
    seamDepth: 0.22, // world units: how far up the seam wall the glow reaches
    envIntensity: 0.5, // procedural studio reflection (high tier only)
  },
  light: {
    key: 1.5, // directional key intensity
    hemi: 0.08,
    ambient: 0.04,
    kicker: 0.6, // soft light from behind the globe
    sweep: 0.6, // 0 = key rides with the camera, 1 = fixed in the world; between, highlights travel as the camera orbits
    keyElevation: 42, // degrees
  },
  halo: {
    opacity: 0.13, // limb brightness
    radius: 1.17, // shell radius in globe radii
    power: 2.8, // falloff (higher = tighter to the limb)
  },
  dust: {
    opacity: 0.55,
    size: 2.4, // px at 1080p
    drift: 0.35, // amplitude multiplier of the slow drift
    parallax: 0.07, // how far the dust shifts against the camera position
  },
  packet: {
    headSize: 34, // px at 1080p
    headBrightness: 1.0,
    speed: 0.05, // loops per second along the test curve
    trailLength: 0.16, // fraction of the loop
    trailWidth: 0.16, // world units at the head
    trailFade: 1.8, // fade exponent toward the tail
    height: 0.55, // world units above the cell top
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
    rim: [0, 2, 0.01], rimPower: [1, 8, 0.1], thickness: [0, 2, 0.01], density: [0, 0.9, 0.01],
    core: [0, 2, 0.01], coreRadius: [0.2, 1, 0.01], roughness: [0.15, 1, 0.01], lift: [0, 1, 0.01],
    bevel: [0, 0.3, 0.005], dome: [0, 1.2, 0.01], relief: [0.3, 2.5, 0.01], sheen: [0, 2, 0.01], pearl: [0, 1.5, 0.01], pearlHorizon: [0, 1.5, 0.01],
    seamGlow: [0, 2, 0.01], seamDepth: [0.05, 0.8, 0.01], envIntensity: [0, 2, 0.01],
  },
  light: { key: [0, 4, 0.05], hemi: [0, 2, 0.02], ambient: [0, 1, 0.01], kicker: [0, 3, 0.05], sweep: [0, 1, 0.01], keyElevation: [5, 80, 1] },
  halo: { opacity: [0, 2, 0.01], radius: [1.04, 1.5, 0.01], power: [0.8, 6, 0.1] },
  dust: { opacity: [0, 1.5, 0.01], size: [0.5, 8, 0.1], drift: [0, 2, 0.01], parallax: [0, 0.3, 0.005] },
  packet: {
    headSize: [4, 48, 1], headBrightness: [0.2, 2, 0.01], speed: [0.01, 0.2, 0.005],
    trailLength: [0.02, 0.3, 0.005], trailWidth: [0.02, 0.4, 0.005], trailFade: [0.5, 4, 0.05], height: [0.2, 1.5, 0.01],
  },
  dissolve: { hexScale: [0.4, 4, 0.05], spread: [0.05, 0.9, 0.01], noise: [0, 1, 0.01], edge: [0.5, 6, 0.05] },
  particles: {
    curlScale: [0.05, 1.5, 0.01], curlStrength: [0, 15, 0.1], curlSpeed: [0, 1, 0.01], cohesion: [0, 1, 0.01],
    attract: [0, 1, 0.005], attractStrength: [0, 30, 0.1], damping: [0.2, 8, 0.1], maxSpeed: [1, 20, 0.1],
    size: [0.5, 8, 0.1], opacity: [0.05, 1, 0.01], textWidth: [6, 26, 0.5], spawnRadius: [2, 20, 0.5],
  },
  post: { chromaticAberration: [0, 0.05, 0.001], grain: [0, 0.12, 0.001], grainSize: [1, 4, 0.1] },
};
