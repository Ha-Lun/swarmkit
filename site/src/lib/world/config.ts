// Look uniforms as data. ROUND 1: every value is a proposal. NOTHING IS LOCKED.
// After the human's verdicts, approved values get frozen here (PLAN §9) and stop being sliders.

export type Tier = 'high' | 'medium';

/** Prism radius of one lattice cell; <1 leaves a visible seam (lattice circumradius is 1). */
export const CELL_RADIUS = 0.94;

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

/** Accent is undecided. Three candidates, shown as swatches and as packets on /lookdev. */
export const accentCandidates = [
  { name: 'cyan', hex: '#4fd8e8' },
  { name: 'violet', hex: '#a98bff' },
  { name: 'coral', hex: '#ff6a55' },
] as const;

export const look = {
  cell: {
    rim: 0.5, // fresnel rim intensity
    rimPower: 3.0, // higher = thinner rim
    thickness: 0.45, // fake-subsurface warm bleed at thin regions (high tier only)
    density: 0.3, // darkening of the dense centre (high tier only)
    core: 0.55, // emissive core strength, agent cells only
    coreRadius: 0.7, // core extent in cell-radius units (<1 stays inside the cell)
    roughness: 0.85,
    lift: 0.35, // world units a hovered/focused cell rises
  },
  light: {
    key: 0.85, // directional key intensity
    hemi: 0.22,
    ambient: 0.05,
  },
  packet: {
    headSize: 26, // px at 1080p
    headBrightness: 1.0,
    speed: 0.05, // loops per second along the test curve
    trailLength: 0.1, // fraction of the loop
    trailWidth: 0.16, // world units at the head
    trailFade: 1.8, // fade exponent toward the tail
    height: 0.55, // world units above the cell top
  },
  dissolve: {
    hexScale: 1.0, // multiplier on the on-screen lattice cell size (1 = native)
    spread: 0.35, // how long each hex takes relative to the whole transition
    noise: 0.25, // 0 = clean radial wavefront, 1 = random per hex
    edge: 1.25, // edge softness in px
  },
  particles: {
    countHigh: 16384,
    countMedium: 4096,
    curlScale: 0.35,
    curlStrength: 5.0,
    curlSpeed: 0.15,
    cohesion: 0.15,
    attract: 0.0, // 0..1, stand-in for chapterProgress
    attractStrength: 9.0,
    damping: 2.2,
    maxSpeed: 8.0,
    size: 2.2, // px at 1080p
    opacity: 0.7,
    textWidth: 16, // world units the target text spans
    spawnRadius: 7,
  },
  post: {
    chromaticAberration: 0.01, // RGB split, grows with distance from centre
    grain: 0.03,
    grainSize: 1.5, // px
  },
};

export type Look = typeof look;

/** [min, max, step] for the lookdev sliders. Keys mirror `look`. */
export const ranges: { [G in keyof Look]?: { [K in keyof Look[G]]?: [number, number, number] } } = {
  cell: {
    rim: [0, 2, 0.01], rimPower: [1, 8, 0.1], thickness: [0, 2, 0.01], density: [0, 0.9, 0.01],
    core: [0, 2, 0.01], coreRadius: [0.2, 1, 0.01], roughness: [0.3, 1, 0.01], lift: [0, 1, 0.01],
  },
  light: { key: [0, 4, 0.05], hemi: [0, 2, 0.02], ambient: [0, 1, 0.01] },
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
