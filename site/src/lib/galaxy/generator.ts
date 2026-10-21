// Procedural galaxy and sky bakers. Deterministic (seeded), allocation-light, no three.js import, so they are testable.
// World units: the galaxy disc is radius GALAXY_R in the XZ plane, y up. Colours are LINEAR.
import { mulberry32, PALETTE } from './shared.ts';

export const GALAXY_R = 10;
type RGB = [number, number, number];

export interface PointCloud {
  count: number;
  position: Float32Array; // count*3
  color: Float32Array; // count*3 (linear, magnitude = brightness)
  data: Float32Array; // count*4: size factor, phase, twinkle speed, aux
}
const cloud = (count: number): PointCloud => ({
  count,
  position: new Float32Array(count * 3),
  color: new Float32Array(count * 3),
  data: new Float32Array(count * 4),
});
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const CORE: RGB = mix3(PALETTE.opus as RGB, [1, 1, 1], 0.55); // white-violet
const WARM: RGB = [1, 0.74, 0.5];
const DEEP: RGB = [0.30, 0.34, 0.85];

/** Twist of the arm centreline: angle offset at normalised radius t (0..1). */
function armTwist(t: number): number {
  return 5.0 * Math.log(1 + t * 5.5) / Math.log(6.5);
}

const ARMS = 4;
/** Arms 0 and 2 are the two dominant log-spirals; 1 and 3 are weaker. Cumulative pick weights. */
const ARM_CUM = [0.42, 0.5, 0.92, 1]; // 42/8/42/8
const pickArm = (u: number): number => (u < ARM_CUM[0] ? 0 : u < ARM_CUM[1] ? 1 : u < ARM_CUM[2] ? 2 : 3);
/** Fixed arm sequence for the haze sprites (faint, so the weak arms may keep a sprite each). */
const ARM_SEQ = [0, 2, 0, 2, 1, 3];
/** Lane blend 0 (teal) .. 1 (amber): varies smoothly with azimuth and radius, so lanes flow into each other. */
const laneMix = (a: number, t: number): number => 0.5 + 0.42 * Math.sin(a - 0.5 + 2.2 * t);
/** Arm lateral spread (world units) at normalised radius t. */
const armSigma = (t: number): number => GALAXY_R * (0.012 + 0.032 * t);
/** Spurs: a few short, faint branches that leave a dominant arm. */
const SPURS = Array.from({ length: 5 }, (_, i) => ({
  arm: (i % 2) * 2,
  t0: 0.3 + ((i * 0.137) % 0.45),
  len: 0.08 + ((i * 0.071) % 0.06),
  slope: (i % 2 ? 1 : -1) * (0.6 + ((i * 0.31) % 0.4)),
}));
const PINK: RGB = [1, 0.72, 0.88]; // HII region

export function buildGalaxy(count: number, seed = 11): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const c = cloud(count);
  const TEAL = PALETTE.opencode as RGB;
  const AMBER = PALETTE.agy as RGB;
  const nArms = Math.round(count * 0.62);
  // small HII-style clusters: each sits on one arm at a fixed radius and lateral offset
  const knots = Array.from({ length: 60 }, () => ({ t: 0.14 + rnd() ** 1.2 * 0.8, arm: pickArm(rnd()), lat: gauss() * 0.8 }));
  const nBulge = Math.round(count * 0.17);
  const nDisc = Math.round(count * 0.14);
  const nHalo = Math.round(count * 0.025);
  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    let z = 0;
    let col: RGB = CORE;
    let bright = 1;
    let size = 1;
    if (i < nArms) {
      const arm = pickArm(rnd());
      const spur = rnd() < 0.09 ? SPURS[Math.floor(rnd() * SPURS.length)] : null;
      const clumped = !spur && rnd() < 0.07;
      const kn = knots[Math.floor(rnd() * knots.length)];
      const u = rnd();
      const t0 = Math.min(1, -Math.log(1 - u * (1 - Math.exp(-1.9))) / 1.9 * 1.05 + 0.02);
      let t = clumped ? Math.min(1, Math.max(0.03, kn.t + gauss() * 0.004)) : t0;
      let spurAng = 0;
      let armI = clumped ? kn.arm : arm;
      if (spur) {
        armI = spur.arm;
        const s = rnd();
        t = Math.min(1, spur.t0 + s * spur.len);
        spurAng = spur.slope * s * spur.len * 3.2;
      }
      const ang = armI * (Math.PI * 2 / ARMS) + armTwist(t) + spurAng;
      const weak = armI === 1 || armI === 3;
      const sigma = armSigma(t) * (spur ? 0.8 : 1) * (clumped ? 0.35 : 1) * (weak ? 2.6 : 1); // weak arms are diffuse feathering, not arms
      // off < 0 is the trailing (inner) edge, where the dust lane sits: thin the stars there
      const off = clumped ? kn.lat * armSigma(t) + gauss() * sigma : gauss() * sigma + (rnd() ** 4) * (rnd() < 0.5 ? -1 : 1) * sigma * 2.5;
      const r = t * GALAXY_R + gauss() * 0.05;
      const a2 = ang + off / Math.max(r, 0.5);
      x = Math.cos(a2) * (r + gauss() * sigma * 0.5);
      z = Math.sin(a2) * (r + gauss() * sigma * 0.5);
      y = gauss() * (0.05 + 0.2 * Math.exp(-t * 2.4)); // flat disc, no warp
      // lane colour flows with azimuth and radius; outer arms go bluish-white with only a tint of the lane
      const lanec = mix3(TEAL, AMBER, Math.min(1, Math.max(0, laneMix(a2, t) + (rnd() - 0.5) * 0.2)));
      const tint = mix3(lanec, [0.82, 0.9, 1], 0.2 + 0.4 * sstep(0.45, 1, t));
      col = mix3(CORE, mix3(tint, [0.8, 0.75, 1], 0.35), sstep(0.04, 0.3, t));
      col = mix3(col, tint, sstep(0.3, 0.62, t));
      const dustSide = off < -sigma * 0.5 ? 1 - 0.55 * sstep(0.5, 2, -off / sigma) : 1;
      const young = rnd() < 0.04;
      bright = (0.55 + rnd() * 0.6) * (1.1 - 0.5 * t) * (spur ? 0.8 : 1) * dustSide * (weak && !clumped ? 0.5 : 1) * (0.3 + 0.7 * sstep(0.05, 0.3, t));
      if (clumped) {
        col = mix3(PINK, [1, 1, 1], 0.3);
        bright = (0.6 + rnd() * 0.5) * (1.1 - 0.4 * t);
        size = 0.7 + rnd() * 0.4;
      } else if (young) {
        col = mix3(col, [1, 1, 1], 0.55);
        bright *= 2;
        size = 1.4 + rnd() * 0.5;
      } else size = 0.55 + rnd() * 0.7;
    } else if (i < nArms + nBulge) {
      const rr = Math.abs(gauss()) * 0.62 + 0.03;
      const th = Math.acos(2 * rnd() - 1);
      const ph = rnd() * Math.PI * 2;
      x = rr * Math.sin(th) * Math.cos(ph);
      z = rr * Math.sin(th) * Math.sin(ph);
      y = rr * Math.cos(th) * 0.62;
      const k = rnd();
      col = mix3(mix3(CORE, [1, 0.92, 0.85], 0.5), WARM, 0.25 + 0.6 * k);
      bright = (0.12 + rnd() * 0.22) * (1.0 - 0.4 * Math.min(1, rr / 1.4));
      size = 0.5 + rnd() * 0.6;
    } else if (i < nArms + nBulge + nDisc) {
      const t = Math.min(1, -Math.log(1 - rnd() * 0.97) * 0.3);
      const ang = rnd() * Math.PI * 2;
      x = Math.cos(ang) * t * GALAXY_R;
      z = Math.sin(ang) * t * GALAXY_R;
      y = gauss() * (0.04 + 0.16 * Math.exp(-t * 2.2));
      col = mix3(CORE, DEEP, sstep(0.05, 0.6, t));
      bright = (0.1 + rnd() * 0.2) * (1 - 0.5 * t);
      size = 0.5 + rnd() * 0.5;
    } else if (i < nArms + nBulge + nDisc + nHalo) {
      const rr = GALAXY_R * (0.2 + rnd() * 0.9);
      const th = Math.acos(2 * rnd() - 1);
      const ph = rnd() * Math.PI * 2;
      x = rr * Math.sin(th) * Math.cos(ph);
      z = rr * Math.sin(th) * Math.sin(ph);
      y = rr * Math.cos(th) * 0.7;
      col = mix3([0.9, 0.85, 1], WARM, rnd() * 0.6);
      bright = 0.18 + rnd() * 0.3;
      size = 0.5 + rnd() * 0.5;
    } else {
      // field stars sprinkled through the disc plane
      const t = Math.sqrt(rnd());
      const ang = rnd() * Math.PI * 2;
      x = Math.cos(ang) * t * GALAXY_R * 1.1;
      z = Math.sin(ang) * t * GALAXY_R * 1.1;
      y = gauss() * 0.3;
      col = mix3([0.85, 0.9, 1], WARM, rnd());
      bright = 0.3 + rnd() * 0.5;
      size = 0.5 + rnd() * 0.6;
    }
    c.position[i * 3] = x;
    c.position[i * 3 + 1] = y;
    c.position[i * 3 + 2] = z;
    c.color[i * 3] = col[0] * bright;
    c.color[i * 3 + 1] = col[1] * bright;
    c.color[i * 3 + 2] = col[2] * bright;
    c.data[i * 4] = size;
    c.data[i * 4 + 1] = rnd();
    c.data[i * 4 + 2] = rnd();
    c.data[i * 4 + 3] = 0;
  }
  return c;
}

/** Angular offset (in arm slots) of the arm the merge grows: it sits between two of the original arms. */
const NEW_ARM_SLOT = 1.5; // between the weak arm 1 and the dominant arm 2
const MINT: RGB = [0.62, 1, 0.8]; // verified, merged green-white

/** The arm the merge adds: a bright, slightly thinner spiral between two existing arms, tinted by both lanes with mint
 *  highlights. data.w = normalised radius t, so the vertex shader can grow it outward from the core (uGrow). */
export function buildNewArm(count: number, seed = 31): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const c = cloud(count);
  const TEAL = PALETTE.opencode as RGB;
  const AMBER = PALETTE.agy as RGB;
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, 0.1 + Math.sqrt(rnd()) * 0.9); // denser toward the rim, where the arm should read
    const ang = NEW_ARM_SLOT * (Math.PI * 2 / ARMS) + armTwist(t);
    const sigma = armSigma(t) * 0.75;
    const off = gauss() * sigma + (rnd() ** 4) * (rnd() < 0.5 ? -1 : 1) * sigma * 2;
    const r = t * GALAXY_R + gauss() * 0.05;
    const a2 = ang + off / Math.max(r, 0.5);
    c.position[i * 3] = Math.cos(a2) * r;
    c.position[i * 3 + 1] = gauss() * (0.05 + 0.18 * Math.exp(-t * 2.4));
    c.position[i * 3 + 2] = Math.sin(a2) * r;
    const tint = mix3(mix3(TEAL, AMBER, Math.min(1, Math.max(0, laneMix(a2, t)))), MINT, 0.2 + 0.25 * rnd());
    let col = mix3(CORE, tint, sstep(0.05, 0.4, t));
    let bright = (0.6 + rnd() * 0.6) * (1.15 - 0.4 * t) * (0.08 + 0.92 * sstep(0.3, 0.7, t)); // thin out the bulge end so it does not wash the core
    let size = 0.4 + rnd() * 0.5;
    if (rnd() < 0.05) {
      col = mix3(col, [1, 1, 1], 0.4);
      bright *= 1.6;
      size = 0.9 + rnd() * 0.4;
    }
    c.color.set([col[0] * bright, col[1] * bright, col[2] * bright], i * 3);
    c.data.set([size, rnd(), rnd(), t], i * 4);
  }
  return c;
}

/** Large, faint, coloured sprites over the arms and around the bulge. Used sparingly. */
export function buildHaze(count: number, seed = 5): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  for (let i = 0; i < count; i++) {
    const arm = ARM_SEQ[i % ARM_SEQ.length];
    const nearCore = i < 6;
    const t = nearCore ? 0.04 + rnd() * 0.1 : 0.14 + rnd() * 0.78;
    const ang = arm * (Math.PI * 2 / ARMS) + armTwist(t) + (rnd() - 0.5) * 0.25;
    const r = t * GALAXY_R;
    c.position[i * 3] = Math.cos(ang) * r;
    c.position[i * 3 + 1] = (rnd() - 0.5) * 0.4;
    c.position[i * 3 + 2] = Math.sin(ang) * r;
    const col = nearCore ? (PALETTE.opus as RGB) : mix3(mix3(PALETTE.opencode as RGB, PALETTE.agy as RGB, laneMix(ang, t)), [0.82, 0.9, 1], 0.35);
    const b = nearCore ? 0.035 : 0.035 + rnd() * 0.03;
    c.color.set([col[0] * b, col[1] * b, col[2] * b], i * 3);
    c.data.set([nearCore ? 4.5 + rnd() * 2 : 3 + rnd() * 4, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

/** Dark dust: faint alpha-blended near-black sprites on the trailing edge of the two dominant arms only. Subtle on purpose:
 *  it must never carve dark quadrants (that reads as a pinwheel). */
export function buildDust(count: number, seed = 9): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  for (let i = 0; i < count; i++) {
    const arm = (i & 1) * 2; // arms 0 and 2
    const t = 0.2 + rnd() * 0.6;
    // just inside the trailing edge of the arm: about 1 to 1.8 arm sigmas behind the centreline
    const ang = arm * (Math.PI * 2 / ARMS) + armTwist(t) - (armSigma(t) / (t * GALAXY_R)) * (1 + 0.8 * rnd());
    const r = t * GALAXY_R;
    c.position[i * 3] = Math.cos(ang) * r;
    c.position[i * 3 + 1] = (rnd() - 0.5) * 0.12;
    c.position[i * 3 + 2] = Math.sin(ang) * r;
    const a = 0.05 + rnd() * 0.08; // stored in colour.x as the alpha
    c.color.set([a, 0, 0], i * 3);
    c.data.set([0.6 + rnd() * 1.0 + (1 - t) * 0.5, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

/** Deep field on a sphere shell. data.x = pixel size, colour carries brightness. */
export function buildSky(count: number, rMin: number, rMax: number, seed: number): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  const temps: RGB[] = [[0.62, 0.74, 1], [1, 1, 1], [1, 0.88, 0.7], [0.85, 0.8, 1]];
  for (let i = 0; i < count; i++) {
    const r = rMin + (rMax - rMin) * rnd();
    const th = Math.acos(2 * rnd() - 1);
    const ph = rnd() * Math.PI * 2;
    c.position.set([r * Math.sin(th) * Math.cos(ph), r * Math.cos(th), r * Math.sin(th) * Math.sin(ph)], i * 3);
    const t = temps[Math.floor(rnd() * temps.length)];
    const b = 0.12 + rnd() ** 3 * 0.9;
    c.color.set([t[0] * b, t[1] * b, t[2] * b], i * 3);
    c.data.set([0.8 + rnd() ** 2 * 1.6, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

// --- Emission nebula -----------------------------------------------------------------
// The page opens on this instead of the galaxy: a lumpy 3D gas volume with a bright dense knot at the
// origin (the comet's target, where a star ignites), dark dust lanes and young stars embedded in the gas.

/** Overall extent of the nebula, in world units. */
export const NEBULA_R = 9;
type V3 = [number, number, number];
type Lobe = { c: V3; s: V3; m: number }; // centre, anisotropic sigma, teal..amber emission mix
/** Five fixed lumpy lobes, placed so the volume is asymmetric in every axis (no disc, no rotational symmetry). */
const LOBES: Lobe[] = [
  { c: [-3.2, 1.6, -2.2], s: [2.3, 1.7, 2.0], m: 0.0 },
  { c: [2.9, -1.3, -3.1], s: [2.1, 1.9, 2.3], m: 1.0 },
  { c: [0.7, 2.7, 2.7], s: [1.8, 1.6, 1.9], m: 0.08 },
  { c: [-1.7, -2.5, 3.3], s: [2.2, 1.5, 1.8], m: 0.95 },
  { c: [4.3, 0.9, 1.7], s: [1.6, 1.4, 1.7], m: 0.5 },
];
const RIM: RGB = [0.85, 0.45, 1.0]; // magenta-violet emission toward the lobe edges
const KNOT_R = 0.8; // the bright dense knot at the origin the comet dives into

/** Cheap deterministic 3D value noise: hashed integer lattice, trilinear with a smooth ramp. */
const n3 = (x: number, y: number, z: number): number => {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const vnoise = (x: number, y: number, z: number): number => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const l = (a: number, b: number, t: number): number => a + (b - a) * t;
  return l(
    l(l(n3(ix, iy, iz), n3(ix + 1, iy, iz), ux), l(n3(ix, iy + 1, iz), n3(ix + 1, iy + 1, iz), ux), uy),
    l(l(n3(ix, iy, iz + 1), n3(ix + 1, iy, iz + 1), ux), l(n3(ix, iy + 1, iz + 1), n3(ix + 1, iy + 1, iz + 1), ux), uy),
    uz,
  );
};
/** Two octaves of value noise, 0..1. */
const fbm = (x: number, y: number, z: number): number =>
  0.65 * vnoise(x, y, z) + 0.35 * vnoise(x * 2.3 + 13.7, y * 2.3 + 71.1, z * 2.3 + 29.3);
/** Displace a sampled gas point by per-axis fbm (coherent, so clumping reads as filaments and pillars). */
const warp = (p: V3, amp: number): void => {
  const dx = (fbm(p[0] + 19.1, p[1] + 47.2, p[2] + 12.9) - 0.5) * 2 * amp;
  const dy = (fbm(p[0] - 23.3, p[1] + 8.7, p[2] + 41.1) - 0.5) * 2 * amp;
  const dz = (fbm(p[0] + 5.5, p[1] + 29.8, p[2] - 17.7) - 0.5) * 2 * amp;
  p[0] += dx;
  p[1] += dy;
  p[2] += dz;
};

/** The emission nebula gas: 5 overlapping anisotropic gaussian lobes of large soft sprites (haze mode like
 *  buildHaze, data.x = sprite size 2..7), displaced by value-noise fbm into filaments and pillars. Per-lobe
 *  teal/amber emission with a magenta-violet rim toward the lobe edges, plus the bright dense knot: 8% of
 *  points within KNOT_R of the origin, white-violet, brighter (up to b 0.12). LINEAR, magnitude = brightness. */
export function buildNebula(count: number, seed = 21): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())));
  };
  const c = cloud(count);
  const TEAL = PALETTE.opencode as RGB;
  const AMBER = PALETTE.agy as RGB;
  const OPUS = PALETTE.opus as RGB;
  const nKnot = Math.round(count * 0.08);
  const lim2 = (NEBULA_R * 1.3) ** 2; // hard bound for the extreme gaussian tail
  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let z: number;
    let col: RGB;
    let b: number;
    let size: number;
    if (i < nKnot) {
      // the knot: steep radial falloff, a few tiny very bright sprites at the centre, bigger fainter ones around
      const u = rnd() ** 1.7;
      const r = KNOT_R * u;
      const th = Math.acos(2 * rnd() - 1);
      const ph = rnd() * Math.PI * 2;
      x = r * Math.sin(th) * Math.cos(ph);
      y = r * Math.cos(th);
      z = r * Math.sin(th) * Math.sin(ph);
      col = mix3(mix3(OPUS, [1, 0.88, 0.95], 0.35), [1, 0.78, 0.85], u * 0.5);
      b = 0.012 + 0.2 * (1 - u) ** 3;
      size = 0.7 + 3.6 * u;
    } else {
      let lobe = LOBES[0];
      let gx = 0;
      let gy = 0;
      let gz = 0;
      let ridge = 0;
      const p: V3 = [0, 0, 0];
      // rejection-sample toward fbm ridges: the filaments and pillars
      for (let t = 0; t < 3; t++) {
        lobe = LOBES[Math.floor(rnd() * LOBES.length)];
        gx = gauss();
        gy = gauss();
        gz = gauss();
        p[0] = lobe.c[0] + gx * lobe.s[0];
        p[1] = lobe.c[1] + gy * lobe.s[1];
        p[2] = lobe.c[2] + gz * lobe.s[2];
        warp(p, 1.0);
        ridge = 1 - Math.abs(2 * fbm(p[0] * 0.9 + 3.1, p[1] * 0.9 + 7.7, p[2] * 0.9 + 1.3) - 1);
        if (rnd() < 0.25 + 0.75 * ridge * ridge) break;
      }
      x = p[0];
      y = p[1];
      z = p[2];
      let r2 = x * x + y * y + z * z;
      // pull outliers inward rather than leaving isolated sprites at the edge
      const soft2 = (NEBULA_R * 0.78) ** 2;
      if (r2 > soft2) {
        const k = Math.sqrt(soft2 / r2) ** 0.5 * 0.97;
        x *= k;
        y *= k;
        z *= k;
        r2 = x * x + y * y + z * z;
      }
      const g2 = gx * gx + gy * gy + gz * gz;
      const hue: RGB = lobe.m > 0.3 && lobe.m < 0.7 ? RIM : mix3(TEAL, AMBER, lobe.m);
      // ionisation front: the side of the lobe facing the knot is brighter and whiter
      const lc = Math.hypot(lobe.c[0], lobe.c[1], lobe.c[2]);
      const facing = -((x - lobe.c[0]) * lobe.c[0] + (y - lobe.c[1]) * lobe.c[1] + (z - lobe.c[2]) * lobe.c[2]) / (lc * 1.9);
      const front = sstep(0.3, 1.6, facing) * sstep(0.4, 1.6, g2) * (1 - sstep(3, 6, g2));
      // overlap of teal and amber summing to olive: dim where both are present
      let wt = 0;
      let wa = 0;
      for (const l of LOBES) {
        const w = Math.exp(-0.5 * (((x - l.c[0]) / l.s[0]) ** 2 + ((y - l.c[1]) / l.s[1]) ** 2 + ((z - l.c[2]) / l.s[2]) ** 2));
        if (l.m < 0.3) wt += w;
        else if (l.m > 0.7) wa += w;
      }
      const overlap = Math.min(wt, wa) / (Math.max(wt, wa) + 1e-6);
      col = mix3(hue, RIM, 0.55 * sstep(2.0, 7, g2));
      col = mix3(col, [1, 0.95, 0.9], 0.35 * front);
      b = (0.02 + rnd() * 0.03 + 0.12 * front * rnd()) * (1 - 0.75 * overlap) * (0.35 + 2.2 * ridge * ridge * ridge);
      b *= 1 - 0.8 * sstep(5.5, 8.5, Math.sqrt(r2)) - 0.0;
      // small sprites on ridges and fronts, big only for the faint outer envelope
      size = 1.0 + 2.6 * rnd() * (1 - 0.7 * ridge) + 2.0 * sstep(2.5, 5, g2) * (1 - ridge);
      // a faint wide envelope of big soft sprites binds the filaments into one body
      if (rnd() < 0.3) {
        size = 3.8 + rnd() * 3;
        b = (0.018 + rnd() * 0.016) * (1 - 0.6 * overlap);
      }
    }
    c.position[i * 3] = x;
    c.position[i * 3 + 1] = y;
    c.position[i * 3 + 2] = z;
    c.color.set([col[0] * b, col[1] * b, col[2] * b], i * 3);
    c.data.set([size, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

/** Dark dust for the nebula (alpha mode like buildDust, alpha in colour.x): faint near-black sprites along 3
 *  curved lanes (seeded quadratic Béziers with small jitter) that cut through the lobes but never cover the
 *  knot — every point is kept beyond 1.2 from the origin. */
export function buildNebulaDust(count: number, seed = 23): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const c = cloud(count);
  // end to end through the volume, the mid control pulling the lane through the gas
  const lane = (): { a: V3; m: V3; b: V3 } => {
    const pt = (rMin: number, rMax: number): V3 => {
      const r = rMin + (rMax - rMin) * rnd();
      const th = Math.acos(2 * rnd() - 1);
      const ph = rnd() * Math.PI * 2;
      return [r * Math.sin(th) * Math.cos(ph), r * Math.cos(th) * 0.85, r * Math.sin(th) * Math.sin(ph)];
    };
    return { a: pt(6.5, 8.5), m: pt(2.0, 5.5), b: pt(6.5, 8.5) };
  };
  // plus lanes along the lobe boundaries (between neighbouring lobe centres, offset outward)
  const edge = (i: number, j: number): { a: V3; m: V3; b: V3 } => {
    const A = LOBES[i].c;
    const B = LOBES[j].c;
    const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
    const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const perp: V3 = [-d[2] * 0.35, d[1] * 0.2 + 0.8, d[0] * 0.35];
    return { a: [A[0] * 1.4 + perp[0], A[1] * 1.4 + perp[1], A[2] * 1.4 + perp[2]], m: [mid[0] + perp[0] * 0.3, mid[1] + perp[1] * 0.3, mid[2] + perp[2] * 0.3], b: [B[0] * 1.4 - perp[0], B[1] * 1.4 - perp[1], B[2] * 1.4 - perp[2]] };
  };
  const lanes = [lane(), lane(), lane(), edge(0, 2), edge(1, 3), edge(2, 4)];
  for (let i = 0; i < count; i++) {
    const ln = lanes[i % lanes.length];
    let x = 0;
    let y = 0;
    let z = 0;
    let r = 0;
    for (let tries = 0; tries < 8; tries++) {
      const t = rnd();
      const u = 1 - t;
      x = u * u * ln.a[0] + 2 * u * t * ln.m[0] + t * t * ln.b[0] + gauss() * 0.35;
      y = u * u * ln.a[1] + 2 * u * t * ln.m[1] + t * t * ln.b[1] + gauss() * 0.35;
      z = u * u * ln.a[2] + 2 * u * t * ln.m[2] + t * t * ln.b[2] + gauss() * 0.35;
      r = Math.hypot(x, y, z);
      if (r > 1.25) break;
    }
    if (r <= 1.25) {
      const k = 1.3 / Math.max(r, 1e-6); // never cover the knot
      x *= k;
      y *= k;
      z *= k;
    }
    c.position.set([x, y, z], i * 3);
    const a = 0.06 + rnd() * 0.1;
    c.color.set([a, 0, 0], i * 3);
    c.data.set([1.2 + rnd() * 1.6, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

/** Young stars embedded in the gas (star sprite mode like buildGalaxy): sampled on a lobe, then a tighter
 *  gaussian so they sit inside it. Mostly blue-white, a few warm; brightness 0.2..1.2 with a long faint tail.
 *  data.x = size factor 0.6..1.6. */
export function buildNebulaStars(count: number, seed = 25): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const c = cloud(count);
  const BLUE: RGB = [0.7, 0.82, 1];
  for (let i = 0; i < count; i++) {
    const lobe = LOBES[Math.floor(rnd() * LOBES.length)];
    const k = 0.45; // tighter than the gas sigma
    const x = lobe.c[0] + gauss() * lobe.s[0] * k;
    const y = lobe.c[1] + gauss() * lobe.s[1] * k;
    const z = lobe.c[2] + gauss() * lobe.s[2] * k;
    const warm = rnd() < 0.12;
    const col = warm ? mix3(BLUE, WARM, 0.5 + rnd() * 0.5) : mix3(BLUE, [1, 1, 1], rnd() * 0.3);
    const b = 0.2 + rnd() ** 3; // 0.2..1.2, long tail
    c.position.set([x, y, z], i * 3);
    c.color.set([col[0] * b, col[1] * b, col[2] * b], i * 3);
    c.data.set([0.6 + rnd(), rnd(), rnd(), 0], i * 4);
  }
  return c;
}
