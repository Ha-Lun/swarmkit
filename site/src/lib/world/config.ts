// Look uniforms as data. Round 11 (human override of round 4's no-glow and round 7-8's matte basalt): premium metallic PBR
// globe (metalness, clearcoat, per-tile roughness/tint jitter, a soft sphere gradient), key+fill+rim+env lighting, an
// emissive core glowing through the seams, GTAO, bloom and a vignette, a gradient background and light fog. Round 9 adds
// agent towers (towerLift, towerStep, capGloss, capBevel). The /lookdev sliders mutate these objects in memory only
// (nothing is persisted), so a reload restores the values here.

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
    seam: 0.06, // width of the engraved seam between panels, constant over the whole globe
    bevel: 0.035, // rounded, beveled edge on the panel top, so the seam catches the key and rim light
    lift: 0.07, // world units a hovered/focused (or comet-struck) panel rises
    // material: machined metal (MeshPhysicalMaterial), a light clearcoat, env IBL doing most of the modelling work
    metalness: 0.7,
    roughness: 0.35,
    clearcoat: 0.3,
    clearcoatRoughness: 0.25,
    sheen: 0.12, // satin lift at grazing angles, small now the clearcoat and env give their own Fresnel
    envIntensity: 1.0, // procedural studio reflection and diffuse room light (both tiers); caps reflect it much harder (capGloss)
    roughJitter: 0.25, // per-tile + fine-noise roughness variation, so the metal never reads as one uniform sheet
    tintJitter: 0.15, // small per-tile shift toward the pale tone, layered on top of hueDrift
    gradient: 0.25, // soft light-top/cool-bottom gradient across the whole sphere (world-space normal.y)
    // basalt (procedural, from the five palette tokens): flat tops, dark striated sides
    sideDark: 0.55, // how dark the column walls are (0 = wax-dim stone, 1 = ink-2)
    grain: 0.2, // fine grain on the tops, high tier only (faded by pixel footprint)
    mottle: 0.2, // slow blotchy tone variation of the tops
    pillow: 0.3, // tops fall off gently toward the edge (a soft pillow gradient, centre lighter): 0 = flat
    hueDrift: 0.5, // per-column drift of the top tone among wax, wax-dim and ink-2, so neighbours are never identical
    detail: 0, // close-up richness of the metal, 0 = the round-11 look. Multi-octave blotches, fine grain, brushed streaks, worn edges, wall strata and pits, wall bump and lift; all procedural, faded by pixel footprint
    grainBump: 0.35, // very fine grain as a bump normal on the tops, high tier only (no cracks, no crags)
    edge: 0.5, // thin catch-light along the chamfer of every column (twice as strong on the caps)
    tone: 0.04, // per-column brightness variation
    // agent towers: stand fixed above every rod, capped with a polished pale cut (no inlay, no ring, no accent)
    towerLift: 0.25, // world units of clear air between the highest a rod can reach and the shortest tower (the gate tier)
    towerStep: 0.1, // extra height per tier: core is 3 steps above the gate tier, t1 2, domain 1
    capGloss: 0.68, // how polished the cap is: the cap's roughness is scaled by (1 - capGloss); the cap also reflects the studio harder
    capBevel: 3, // the cap's chamfer width as a multiple of the filler bevel
    agentTone: 0.35, // how much lighter the cap stone is than filler
    hover: 0.45, // tone brightening of a hovered/focused panel
    // the moon's own motion (round 10): it spins about its own axis, drifts along a small tilted ellipse round its home and pumps its rods lightly; the story parks it
    moonTurnSec: 40, // seconds per full turn of the moon's own spin
    moonDrift: 0.35, // farthest the moon drifts from home, in globe radii (capped so it never reaches the globe)
    moonStroke: 0.3, // the moon's rod throw as a fraction of the globe's (stroke)
  },
  light: {
    key: 3.0, // directional key intensity (lower than round 8: the key now rakes at 30 degrees, so tops catch more of it)
    hemi: 0.05,
    ambient: 0.03, // low, so walls and tops read as different planes
    fill: 0.4, // dim directional opposite the key, no shadow: keeps the shadow side of the metal from going black
    kicker: 1.4, // rim light from behind the globe, raised for round 11: a harder rim on the limb and the bevels
    sweep: 0.6, // 0 = key rides with the camera, 1 = fixed in the world; between, highlights travel as the camera orbits
    keyElevation: 30, // degrees: a low, raking key
  },
  walk: {
    // the ground view (round 14), all scaled by the walk weight so the orbit views are untouched
    lantern: 8, // a small point light just behind and above the walker's eye (intensity, decay 2): lifts the near walls and tower shafts out of black
    lanternRange: 6, // world units it reaches
    fillBoost: 12, // hemisphere and ambient light are multiplied by (1 + fillBoost x weight), so the far walls are not pure black
    wallLift: 1.2, // the column walls' albedo is multiplied by (1 + wallLift x weight): their stone is near ink, and metalness leaves almost no diffuse to light
    ao: 0.35, // the fraction of the GTAO strength kept under the walker (x the walk weight): in the tight streets full strength crushed every wall to black on the high tier
    bloom: 0.3, // the fraction of the bloom strength kept near the surface: close-up tile tops throw big glare
    bloomLift: 0.6, // ... and the bloom threshold is raised by this much there
    haze: 1, // the cool glow along the globe's limb in the walker's sky (sky.ts), and the colour the ground fog fades to
    stars: 1, // brightness of the small stars above it
    wallMatte: 0.7, // the column walls' metalness is multiplied by (1 - wallMatte x weight): plain stone takes the light, polished metal only mirrors the dark env
    towerWall: 0.5, // the tower shafts' stone as a fraction of the cap's pale tone (x the walk weight): the whole pillar reads, not only its cap
    topRough: 1.2, // extra roughness on the tile tops (not the caps): the key's highlight spreads instead of mirroring into the lens
  },
  core: {
    color: 0.5, // 0..1 mix toward the pale tone (a cool iron-blue floor stays in at every value; never the comet accent)
    intensity: 2.5, // HDR multiplier on the globe's seam floor: values above 1 bloom through the seams. The moon's floor stays dark ink.
  },
  bg: {
    gradient: 0.6, // strength of the radial background gradient (ink-2 centre to ink edge)
    fog: 1.0, // scales the fog distances set in world.ts/lookdev.astro: > 1 = lighter (farther) fog
  },
  packet: {
    // the comet (round 16: real 3D): a glass orb head (frosted, translucent, glowing core) and a tapered glass tube tail that grows with speed, shed sparks. Lit by the studio, casts a shadow. Nothing additive, no bloom.
    headRadius: 0.24, // world units
    headGlow: 0.55, // emissive strength: keeps the shadow side readable
    glassOpacity: 0.5, // 0..1: how much the glass body hides what is behind it (the core inside always shows)
    headBrightness: 1.0,
    tailMin: 1.0, // world units of tail at rest
    tailGain: 0.9, // extra tail per (unit/s) of visible speed
    tailMax: 6,
    tailRadius: 0.85, // tail radius at the head, as a fraction of headRadius
    tailFade: 1.5, // darkening exponent toward the tail end
    sparks: 1.2, // emission strength (0 = none)
    height: 0.36, // constant lift above the panel tops (clears the head sphere and a struck panel's lift)
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
    exposure: 1.0, // renderer.toneMappingExposure (ACES)
    bloomStrength: 0.35,
    bloomRadius: 0.4,
    bloomThreshold: 0.85, // luminance floor: only highlights and the core bloom
    aoIntensity: 1.0, // GTAO blend strength, high tier only
    aoRadius: 0.25, // GTAO world-space sample radius, high tier only
    vignette: 0.35,
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
    metalness: [0, 1, 0.01], roughness: [0.05, 1, 0.01], clearcoat: [0, 1, 0.01], clearcoatRoughness: [0, 1, 0.01],
    sheen: [0, 1.5, 0.01], envIntensity: [0, 2, 0.01], roughJitter: [0, 1, 0.01], tintJitter: [0, 1, 0.01], gradient: [0, 1, 0.01],
    sideDark: [0, 1, 0.01], grain: [0, 1, 0.01], mottle: [0, 1, 0.01], pillow: [0, 0.8, 0.01], hueDrift: [0, 1, 0.01], grainBump: [0, 1, 0.01], detail: [0, 1, 0.01], edge: [0, 1.5, 0.01], tone: [0, 0.2, 0.005],
    towerLift: [0, 1, 0.01], towerStep: [0, 0.3, 0.005], capGloss: [0, 0.95, 0.01], capBevel: [1, 6, 0.1],
    agentTone: [0, 0.6, 0.01], hover: [0, 1.2, 0.01],
    moonTurnSec: [8, 120, 1], moonDrift: [0, 0.6, 0.01], moonStroke: [0, 1, 0.01],
  },
  light: { key: [0, 4, 0.05], hemi: [0, 2, 0.02], ambient: [0, 1, 0.01], fill: [0, 2, 0.02], kicker: [0, 3, 0.05], sweep: [0, 1, 0.01], keyElevation: [5, 80, 1] },
  walk: { lantern: [0, 16, 0.05], lanternRange: [1, 12, 0.1], fillBoost: [0, 24, 0.1], wallLift: [0, 20, 0.1], wallMatte: [0, 1, 0.01], towerWall: [0, 1, 0.01], topRough: [0, 2, 0.01] },
  core: { color: [0, 1, 0.01], intensity: [0, 6, 0.05] },
  bg: { gradient: [0, 1, 0.01], fog: [0.3, 2, 0.01] },
  packet: {
    headRadius: [0.03, 0.4, 0.005], headGlow: [0, 2, 0.01], glassOpacity: [0.1, 1, 0.01], headBrightness: [0.2, 2, 0.01], tailMin: [0, 2, 0.02], tailGain: [0, 2, 0.01], tailMax: [0.5, 12, 0.05],
    tailRadius: [0.1, 1.5, 0.01], tailFade: [0.3, 4, 0.05], sparks: [0, 2, 0.05], height: [0.05, 0.8, 0.01],
  },
  dissolve: { hexScale: [0.4, 4, 0.05], spread: [0.05, 0.9, 0.01], noise: [0, 1, 0.01], edge: [0.5, 6, 0.05] },
  particles: {
    curlScale: [0.05, 1.5, 0.01], curlStrength: [0, 15, 0.1], curlSpeed: [0, 1, 0.01], cohesion: [0, 1, 0.01],
    attract: [0, 1, 0.005], attractStrength: [0, 30, 0.1], damping: [0.2, 8, 0.1], maxSpeed: [1, 20, 0.1],
    size: [0.5, 8, 0.1], opacity: [0.05, 1, 0.01], textWidth: [6, 26, 0.5], spawnRadius: [2, 20, 0.5],
  },
  post: {
    exposure: [0.4, 2, 0.01], bloomStrength: [0, 1.5, 0.01], bloomRadius: [0, 1, 0.01], bloomThreshold: [0, 1.5, 0.01],
    aoIntensity: [0, 2, 0.01], aoRadius: [0.05, 1, 0.01], vignette: [0, 1, 0.01],
    chromaticAberration: [0, 0.05, 0.001], grain: [0, 0.12, 0.001], grainSize: [1, 4, 0.1],
  },
};
