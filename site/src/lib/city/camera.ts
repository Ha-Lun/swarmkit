// SwarmKit City camera: one continuous path through per-beat keyframes. Pure (plain node runs it; tests in
// test/city/scene-logic.test.ts). The keyframes come from the beats and the layout, never from one run's numbers:
// each beat frames a rect of the layout (bounds, plot, plot + depots, plot + block, block) at a pitch and yaw.
// Position and look-at target each follow a uniform Catmull-Rom curve (C1 in its parameter); scroll progress u maps to the curve
// parameter through a monotone cubic (Fritsch-Carlson), so the camera speed is continuous across beat boundaries
// and never stops at one.
import { CatmullRomCurve3, Vector3 } from 'three';
import { H_MAX, MERGE_LIFT, ROAD_W } from './lots.ts';
import type { Beat, BeatId, LotLayout, Rect } from './types.ts';

/** Vertical field of view of the scene camera (degrees). */
export const CAMERA_FOV = 35;

export interface CameraKey {
  beat: BeatId;
  /** Scroll progress this pose is reached at, strictly increasing over the keys. */
  u: number;
  pos: [number, number, number];
  target: [number, number, number];
}

/** How a beat frames the layout: which rect, how far (multiple of the fit distance), pitch and yaw (degrees). */
interface Shot {
  rect: (l: LotLayout) => Rect;
  zoom: number;
  pitch: number;
  yaw: number;
  /** Where in the beat the pose is reached, 0..1. */
  at: number;
  /** Where the rect's centre lands on screen (NDC, -1..1) for landscape and portrait: keeps it clear of DOM panels. */
  offset?: { landscape: [number, number]; portrait: [number, number] };
  /**
   * Portrait overrides. A phone is tall and narrow, so the layout is turned (PORTRAIT_YAW, shared by all beats) to run
   * up the screen and seen more from above (pitch): the fit is then bound by height, not width, and the city fills
   * the screen.
   */
  portrait?: { pitch?: number; zoom?: number; rect?: (l: LotLayout) => Rect };
}

/**
 * Portrait yaw (degrees), the same for every beat. The view direction is the Catmull-Rom curve of (camera - target),
 * and with one yaw all those offsets point the same way, so the view never swings between beats on a phone; only
 * pitch and distance change. ~82 runs the layout's long x axis up the screen.
 */
const PORTRAIT_YAW = 82;

const union = (...rs: Rect[]): Rect => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rs) {
    x0 = Math.min(x0, r.x - r.w / 2);
    x1 = Math.max(x1, r.x + r.w / 2);
    z0 = Math.min(z0, r.z - r.d / 2);
    z1 = Math.max(z1, r.z + r.d / 2);
  }
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
};
const depotRects = (l: LotLayout): Rect[] => l.depots.map((d) => ({ x: d.x, z: d.z, w: l.cell, d: l.cell }));
/** The block when there is one (no workers = empty block), else the plot. */
const blockOr = (l: LotLayout): Rect => (l.cityBlock.w > 0 ? l.cityBlock : l.plot);

/** The empty slots the new lots merge into (plus a street of margin), else the plot. */
const slotsOr = (l: LotLayout): Rect => {
  const slots = l.block.filter((_, i) => !l.lots[i].extra);
  if (!slots.length) return l.plot;
  const u = union(...slots);
  return { ...u, w: u.w + 2 * ROAD_W, d: u.d + 2 * ROAD_W };
};

/**
 * Per-beat shots. Yaw 0 looks from +z towards -z; positive yaw swings the camera towards +x. `zoom` multiplies the
 * exact fit distance (1 = the rect's box just fits inside the padded frame for this aspect; below 1 crops).
 */
const SHOTS: Record<BeatId, Shot> = {
  // A finished city with an empty lot beside it: the whole city plus the blueprint plot.
  // The hero panel sits top-left (top on phones): the city sits right of and below the panel.
  hero: {
    rect: (l) => union(blockOr(l), l.plot), zoom: 0.96, pitch: 36, yaw: 28, at: 0,
    offset: { landscape: [0.24, -0.03], portrait: [0, -0.03] },
    // Portrait: the city and its empty slots fill the band between the hero panel and the caption; the plot is
    // mostly out of frame at u = 0 (blank paper then) and slides in on the way to the task beat.
    portrait: { pitch: 50, zoom: 1.0, rect: blockOr },
  },
  task: { rect: (l) => l.plot, zoom: 1.15, pitch: 52, yaw: 16, at: 0.6, portrait: { pitch: 56 } },
  plan: { rect: (l) => l.plot, zoom: 1.3, pitch: 78, yaw: 6, at: 0.55, portrait: { pitch: 78 } },
  // Both depots and the plot, fully in frame (zoom >= 1 keeps the padding).
  lanes: { rect: (l) => union(l.plot, ...depotRects(l)), zoom: 1.05, pitch: 40, yaw: 30, at: 0.5, portrait: { pitch: 48 } },
  verify: { rect: (l) => l.plot, zoom: 0.95, pitch: 38, yaw: 36, at: 0.5, portrait: { pitch: 46 } },
  merge: { rect: (l) => union(l.plot, slotsOr(l)), zoom: 1.2, pitch: 40, yaw: 18, at: 0.6, portrait: { pitch: 52, zoom: 1.1 } },
  review: { rect: (l) => union(slotsOr(l), ...l.annex), zoom: 1.25, pitch: 36, yaw: 14, at: 0.5, portrait: { pitch: 50, zoom: 1.15 } },
  bill: { rect: (l) => l.bounds, zoom: 1.5, pitch: 46, yaw: 8, at: 1, portrait: { pitch: 56, zoom: 1.35 } },
};

/** Height of the framed box (m): the tallest a new building can get, plus the lift while it merges. */
const FRAME_H = H_MAX + MERGE_LIFT;
/** Look-at height (m). */
const TARGET_Y = 0.6;

/** Clear margins of the frame, as fractions of the half-width / half-height (NDC units / 1). */
export interface FramePad { x: number; top: number; bottom: number }
/**
 * Landscape: the caption (bottom-left) and the HUD (bottom-right) share the bottom band, so the subject is fitted
 * above it. Portrait: the HUD sits at the top, the caption at the bottom; the subject fits between them. Sized for
 * city.css (HUD and caption heights); the camera test checks the keys against these bands.
 */
export const FRAME_PAD: { landscape: FramePad; portrait: FramePad } = {
  landscape: { x: 0.07, top: 0.06, bottom: 0.3 },
  portrait: { x: 0.05, top: 0.33, bottom: 0.27 },
};
export const framePad = (aspect: number): FramePad => FRAME_PAD[aspect < 1 ? 'portrait' : 'landscape'];

/**
 * Exact fit: the smallest distance from the rect's centre at which every corner of the rect's box (ground to FRAME_H)
 * projects inside the padded frame, in both width and height, for this aspect, pitch and yaw (radians).
 */
export function fitDistance(r: Rect, aspect: number, fovDeg: number, pitch: number, yaw: number, ox = 0, oy = 0): number {
  const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
  // Camera basis: back (target -> camera), right, up.
  const bx = cp * sy, by = sp, bz = cp * cy;
  const rx = cy, rz = -sy; // right = up x back, normalised (ry = 0)
  const ux = by * rz, uy = bz * rx - bx * rz, uz = -by * rx; // up = back x right
  const tanV = Math.tan(((fovDeg * Math.PI) / 180) / 2);
  const pad = framePad(aspect);
  const tanT = tanV * (1 - pad.top), tanB = tanV * (1 - pad.bottom), tanX = tanV * aspect * (1 - pad.x);
  // With the centre shifted to (ox, oy) on screen, a point's offset from the view axis gains o * tan * d.
  const shx = ox * tanV * aspect, shy = oy * tanV;
  let d = 0;
  for (const dx of [-r.w / 2, r.w / 2]) {
    for (const dz of [-r.d / 2, r.d / 2]) {
      for (const dy of [-TARGET_Y, FRAME_H - TARGET_Y]) {
        const xc = dx * rx + dz * rz;
        const yc = dx * ux + dy * uy + dz * uz;
        const zc = dx * bx + dy * by + dz * bz;
        d = Math.max(
          d,
          (xc + tanX * zc) / (tanX - shx), (tanX * zc - xc) / (tanX + shx),
          (yc + tanT * zc) / (tanT - shy), (tanB * zc - yc) / (tanB + shy),
        );
      }
    }
  }
  return d;
}

/** Scroll progress at which beat b's pose is reached: hero at 0, bill at 1, the others at `at` inside the beat. */
function keyU(b: Beat): number {
  return b.id === 'hero' ? 0 : b.id === 'bill' ? 1 : b.u0 + (b.u1 - b.u0) * SHOTS[b.id].at;
}

/**
 * Camera keyframes for these beats and this layout: one per present beat (hero at u = 0, bill at u = 1, the middle
 * beats inside their own scroll range). Pure; aspect (width / height) only changes the distances.
 */
export function buildCameraKeys(layout: LotLayout, beats: Beat[], aspect = 16 / 9, fovDeg = CAMERA_FOV): CameraKey[] {
  const keys: CameraKey[] = [];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  for (const b of beats) {
    if (!b.present) continue;
    const shot = SHOTS[b.id];
    const u = keyU(b);
    if (keys.length && u <= keys[keys.length - 1].u + 1e-6) continue; // zero-length beat: keep the earlier pose
    const p = a < 1 ? shot.portrait : undefined;
    const r = (p?.rect ?? shot.rect)(layout);
    const pitch = ((p?.pitch ?? shot.pitch) * Math.PI) / 180;
    const yaw = ((a < 1 ? PORTRAIT_YAW : shot.yaw) * Math.PI) / 180;
    const [ox, oy] = shot.offset ? shot.offset[a < 1 ? 'portrait' : 'landscape'] : [0, 0];
    const dist = fitDistance(r, a, fovDeg, pitch, yaw, ox, oy) * (p?.zoom ?? shot.zoom);
    // Shift camera and target together (the view direction stays) so the rect's centre lands at (ox, oy).
    const tanV = Math.tan(((fovDeg * Math.PI) / 180) / 2);
    const lx = -ox * tanV * a * dist, ly = -oy * tanV * dist;
    const cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw);
    const shift = [lx * cy + ly * -sp * sy, ly * cp, lx * -sy + ly * -sp * cy];
    const tx = r.x + shift[0], ty = TARGET_Y + shift[1], tz = r.z + shift[2];
    keys.push({
      beat: b.id,
      u,
      pos: [tx + dist * cp * sy, ty + dist * sp, tz + dist * cp * cy],
      target: [tx, ty, tz],
    });
  }
  if (keys.length && keys[keys.length - 1].u < 1) keys.push({ ...keys[keys.length - 1], u: 1 });
  if (keys.length === 1) keys.unshift({ ...keys[0], u: 0 });
  return keys;
}

/** Fritsch-Carlson monotone cubic through (xs[i], ys[i]); xs strictly increasing. C1 and never overshoots. */
export function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  if (n < 2) return () => (n ? ys[0] : 0);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export interface CameraPath {
  keys: CameraKey[];
  /** Writes the camera position and look-at target for scroll progress u (clamped) into the outs. Allocation-free. */
  poseAt(u: number, outPos: { x: number; y: number; z: number }, outTarget: { x: number; y: number; z: number }): void;
}

const scratch = new Vector3();

export function createCameraPath(keys: CameraKey[]): CameraPath {
  if (keys.length < 2) throw new Error('createCameraPath: needs at least two keys');
  const posCurve = new CatmullRomCurve3(keys.map((k) => new Vector3(...k.pos)), false, 'catmullrom', 0.5);
  const tgtCurve = new CatmullRomCurve3(keys.map((k) => new Vector3(...k.target)), false, 'catmullrom', 0.5);
  const n = keys.length;
  const toT = monotoneCubic(keys.map((k) => k.u), keys.map((_, i) => i / (n - 1)));
  return {
    keys,
    poseAt(u, outPos, outTarget) {
      const x = u <= 0 || Number.isNaN(u) ? 0 : u >= 1 ? 1 : u;
      const t = Math.min(1, Math.max(0, toT(x)));
      posCurve.getPoint(t, scratch);
      outPos.x = scratch.x; outPos.y = scratch.y; outPos.z = scratch.z;
      tgtCurve.getPoint(t, scratch);
      outTarget.x = scratch.x; outTarget.y = scratch.y; outTarget.z = scratch.z;
    },
  };
}

/**
 * Critically damped follow of `target` (Game Programming Gems 4, "smooth damp"). `state.v` carries the velocity
 * between calls. smoothTime ~ the time to cover most of the gap (s). Returns the new value.
 */
export function smoothDamp(current: number, target: number, state: { v: number }, smoothTime: number, dt: number): number {
  if (!(dt > 0)) return current;
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  // no overshoot past the target
  if ((target - current > 0) === (out > target)) {
    out = target;
    state.v = 0;
  }
  return out;
}

/** Each present beat's keyframe u (where its camera pose is exact), in beat order. */
export function beatKeyUs(beats: Beat[]): { beat: BeatId; u: number }[] {
  return beats.filter((b) => b.present).map((b) => ({ beat: b.id, u: keyU(b) }));
}

/**
 * u snapped to the pose a static (reduced-motion / low tier) frame shows for the beat under u: that beat's camera
 * keyframe, so a static frame is always one of the exact poses of the moving camera.
 */
export function beatPoseU(beats: Beat[], u: number): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  for (const b of beats) {
    if (b.u1 > b.u0 && x >= b.u0 && (x < b.u1 || b.u1 >= 1)) return keyU(b);
  }
  return x;
}
