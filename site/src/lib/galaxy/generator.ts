// Procedural galaxy and sky bakers. Deterministic (seeded), allocation-light, no three.js import, so they are testable.
// World units: the galaxy disc is radius GALAXY_R in the XZ plane, y up. Colours are LINEAR (same as swarm PALETTE).
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
export function armTwist(t: number): number {
  return 5.0 * Math.log(1 + t * 5.5) / Math.log(6.5);
}

export const ARMS = 4;
/** Spurs: short branches that leave a main arm and fan outward. */
const SPURS = Array.from({ length: 14 }, (_, i) => ({
  arm: i % ARMS,
  t0: 0.2 + ((i * 0.137) % 0.55),
  len: 0.12 + ((i * 0.071) % 0.12),
  slope: (i % 2 ? 1 : -1) * (0.9 + ((i * 0.31) % 0.8)),
}));

export function buildGalaxy(count: number, seed = 11): PointCloud {
  const rnd = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(1e-6, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const c = cloud(count);
  const lane: RGB[] = [PALETTE.opencode as RGB, PALETTE.agy as RGB];
  const nArms = Math.round(count * 0.62);
  const knots = Array.from({ length: 96 }, () => ({ t: 0.08 + rnd() ** 1.3 * 0.9 }));
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
      const arm = i % ARMS;
      const spur = rnd() < 0.24 ? SPURS[Math.floor(rnd() * SPURS.length)] : null;
      const clumped = !spur && rnd() < 0.3;
      const kn = knots[Math.floor(rnd() * knots.length)];
      const u = rnd();
      const t0 = Math.min(1, -Math.log(1 - u * (1 - Math.exp(-3.0))) / 3.0 * 1.05 + 0.02);
      let t = clumped ? Math.min(1, Math.max(0.03, kn.t + gauss() * 0.012)) : t0;
      let spurAng = 0;
      let armI = arm;
      if (spur) {
        armI = spur.arm;
        const s = rnd();
        t = Math.min(1, spur.t0 + s * spur.len);
        spurAng = spur.slope * s * spur.len * 3.2;
      }
      const ang = armI * (Math.PI * 2 / ARMS) + armTwist(t) + spurAng;
      const sigma = GALAXY_R * (0.011 + 0.04 * t) * (spur ? 0.8 : 1);
      const off = gauss() * sigma + (rnd() ** 4) * (rnd() < 0.5 ? -1 : 1) * sigma * 3;
      const r = t * GALAXY_R + gauss() * 0.06;
      const a2 = ang + off / Math.max(r, 0.5);
      x = Math.cos(a2) * (r + gauss() * sigma * 0.5);
      z = Math.sin(a2) * (r + gauss() * sigma * 0.5);
      y = gauss() * (0.05 + 0.2 * Math.exp(-t * 2.4)) + 0.5 * t ** 2.4 * Math.sin(a2 - 0.6);
      const tint = mix3(lane[armI & 1], PALETTE.opus as RGB, rnd() * 0.3);
      // white-violet core, violet-tinted lane colour mid disc, saturated teal / amber at the rim
      col = mix3(CORE, mix3(tint, [0.8, 0.7, 1], 0.45), sstep(0.04, 0.3, t));
      col = mix3(col, tint, sstep(0.3, 0.62, t));
      col = mix3(col, [col[0] * 0.6, col[1] * 0.66, col[2] * 0.85], sstep(0.7, 1, t));
      const young = rnd() < 0.05;
      bright = (0.6 + rnd() * 0.7) * (1.15 - 0.5 * t) * (clumped ? 1.3 : 1) * (spur ? 0.9 : 1);
      if (young) {
        col = mix3(col, [1, 1, 1], 0.55);
        bright *= 2.2;
        size = 1.5 + rnd() * 0.6;
      } else size = 0.55 + rnd() * 0.7;
    } else if (i < nArms + nBulge) {
      const rr = Math.abs(gauss()) * 0.85 + 0.03;
      const th = Math.acos(2 * rnd() - 1);
      const ph = rnd() * Math.PI * 2;
      x = rr * Math.sin(th) * Math.cos(ph);
      z = rr * Math.sin(th) * Math.sin(ph);
      y = rr * Math.cos(th) * 0.62;
      const k = rnd();
      col = mix3(CORE, WARM, k < 0.25 ? k * 1.1 : 0);
      bright = (0.3 + rnd() * 0.5) * (1.0 - 0.4 * Math.min(1, rr / 1.8));
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

/** Angular offset (in arm slots) of the arm the merge grows: it sits between two of the four original arms. */
export const NEW_ARM_SLOT = 1.5;
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
  const lane: RGB[] = [PALETTE.opencode as RGB, PALETTE.agy as RGB];
  for (let i = 0; i < count; i++) {
    const t = Math.min(1, 0.1 + Math.sqrt(rnd()) * 0.9); // denser toward the rim, where the arm should read
    const ang = NEW_ARM_SLOT * (Math.PI * 2 / ARMS) + armTwist(t);
    const sigma = GALAXY_R * (0.012 + 0.036 * t);
    const off = gauss() * sigma + (rnd() ** 4) * (rnd() < 0.5 ? -1 : 1) * sigma * 2.5;
    const r = t * GALAXY_R + gauss() * 0.05;
    const a2 = ang + off / Math.max(r, 0.5);
    c.position[i * 3] = Math.cos(a2) * r;
    c.position[i * 3 + 1] = gauss() * (0.05 + 0.18 * Math.exp(-t * 2.4)) + 0.5 * t ** 2.4 * Math.sin(a2 - 0.6);
    c.position[i * 3 + 2] = Math.sin(a2) * r;
    const tint = mix3(lane[i & 1], MINT, 0.35 + 0.3 * rnd());
    let col = mix3(CORE, tint, sstep(0.05, 0.4, t));
    let bright = (0.6 + rnd() * 0.6) * (1.15 - 0.4 * t) * (0.12 + 0.88 * sstep(0.12, 0.5, t)); // thin out the bulge end so it does not wash the core
    let size = 0.55 + rnd() * 0.7;
    if (rnd() < 0.06) {
      col = mix3(col, [1, 1, 1], 0.5);
      bright *= 1.8;
      size = 1.4 + rnd() * 0.6;
    }
    c.color.set([col[0] * bright, col[1] * bright, col[2] * bright], i * 3);
    c.data.set([size, rnd(), rnd(), t], i * 4);
  }
  return c;
}

/** A few large faint sprites along the new arm (same grow convention as buildNewArm). */
export function buildNewArmHaze(count: number, seed = 33): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  for (let i = 0; i < count; i++) {
    const t = 0.3 + rnd() * 0.64;
    const ang = NEW_ARM_SLOT * (Math.PI * 2 / ARMS) + armTwist(t) + (rnd() - 0.5) * 0.2;
    const r = t * GALAXY_R;
    c.position.set([Math.cos(ang) * r, (rnd() - 0.5) * 0.4, Math.sin(ang) * r], i * 3);
    const col = mix3(MINT, i & 1 ? (PALETTE.agy as RGB) : (PALETTE.opencode as RGB), 0.45);
    const b = 0.05 + rnd() * 0.035;
    c.color.set([col[0] * b, col[1] * b, col[2] * b], i * 3);
    c.data.set([3 + rnd() * 4, rnd(), rnd(), t], i * 4);
  }
  return c;
}

/** Large, faint, coloured sprites over the arms and around the bulge. Used sparingly. */
export function buildHaze(count: number, seed = 5): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  const lane: RGB[] = [PALETTE.opencode as RGB, PALETTE.agy as RGB];
  for (let i = 0; i < count; i++) {
    const arm = i % ARMS;
    const nearCore = i < 6;
    const t = nearCore ? 0.04 + rnd() * 0.1 : 0.14 + rnd() * 0.78;
    const ang = arm * (Math.PI * 2 / ARMS) + armTwist(t) + (rnd() - 0.5) * 0.25;
    const r = t * GALAXY_R;
    c.position[i * 3] = Math.cos(ang) * r;
    c.position[i * 3 + 1] = (rnd() - 0.5) * 0.4;
    c.position[i * 3 + 2] = Math.sin(ang) * r;
    const col = nearCore ? (PALETTE.opus as RGB) : mix3(lane[arm & 1], PALETTE.opus as RGB, 0.25);
    const b = nearCore ? 0.035 : 0.035 + rnd() * 0.03;
    c.color.set([col[0] * b, col[1] * b, col[2] * b], i * 3);
    c.data.set([nearCore ? 4.5 + rnd() * 2 : 3 + rnd() * 4, rnd(), rnd(), 0], i * 4);
  }
  return c;
}

/** Dark dust: alpha-blended near-black sprites on the trailing edge of each arm and across the bulge. */
export function buildDust(count: number, seed = 9): PointCloud {
  const rnd = mulberry32(seed);
  const c = cloud(count);
  for (let i = 0; i < count; i++) {
    const arm = i % ARMS;
    const t = 0.16 + rnd() * 0.7;
    const ang = arm * (Math.PI * 2 / ARMS) + armTwist(t) - (0.11 + 0.1 * rnd()) * (1.5 - t);
    const r = t * GALAXY_R;
    c.position[i * 3] = Math.cos(ang) * r;
    c.position[i * 3 + 1] = (rnd() - 0.5) * 0.12;
    c.position[i * 3 + 2] = Math.sin(ang) * r;
    const a = 0.2 + rnd() * 0.28; // stored in colour.x as the alpha
    c.color.set([a, 0, 0], i * 3);
    c.data.set([0.8 + rnd() * 1.6 + (1 - t) * 0.8, rnd(), rnd(), 0], i * 4);
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

export interface StreakMesh {
  count: number;
  position: Float32Array; // per vertex (4 per star): star centre
  corner: Float32Array; // per vertex: [end 0|1, side -1|1]
  data: Float32Array; // per vertex: [lengthFactor, brightness, seed]
  index: Uint32Array;
}
/** Stars in a tunnel around the camera axis, in three depth layers (far dim and many, near bright and few). position is
 *  [right offset, up offset, depth phase 0..1]; the vertex shader places it relative to the camera. data is
 *  [length factor, brightness, layer 0 far .. 1 near]. */
export function buildStreaks(count: number, seed = 21): StreakMesh {
  const rnd = mulberry32(seed);
  const position = new Float32Array(count * 4 * 3);
  const corner = new Float32Array(count * 4 * 2);
  const data = new Float32Array(count * 4 * 3);
  const index = new Uint32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const k = rnd();
    const layer = k < 0.5 ? rnd() * 0.3 : k < 0.82 ? 0.4 + rnd() * 0.25 : 0.8 + rnd() * 0.2;
    const [r0, r1] = layer < 0.35 ? [1.8, 9] : layer < 0.7 ? [1.3, 4.4] : [1.0, 2.6];
    const r = r0 + (r1 - r0) * rnd() ** 0.8;
    const th = rnd() * Math.PI * 2;
    const ph = rnd();
    const lf = 0.6 + rnd() * 0.9;
    const br = 0.4 + rnd() * 0.6;
    for (let v4 = 0; v4 < 4; v4++) {
      const v = i * 4 + v4;
      position.set([Math.cos(th) * r, Math.sin(th) * r, ph], v * 3);
      corner.set([v4 >> 1, v4 & 1 ? 1 : -1], v * 2);
      data.set([lf, br, layer], v * 3);
    }
    const b = i * 4;
    index.set([b, b + 1, b + 2, b + 1, b + 3, b + 2], i * 6);
  }
  return { count, position, corner, data, index };
}

/** Comet tail particles: aT along the tail (0 head .. 1 end), random scatter. */
export function buildComet(count: number, seed = 3): { t: Float32Array; rand: Float32Array } {
  const rnd = mulberry32(seed);
  const t = new Float32Array(count);
  const rand = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    t[i] = i < 40 ? rnd() * 0.02 : rnd() ** 1.6;
    rand.set([rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1], i * 3);
  }
  return { t, rand };
}
