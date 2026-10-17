// SwarmKit City camera: one continuous path through per-beat keyframes. Pure (plain node runs it; tests in
// test/city/scene-logic.test.ts). The keyframes come from the beats and the layout, never from one run's numbers:
// each beat frames a rect of the layout (bounds, plot, plot + depots, plot + block, block) at a pitch and yaw.
// Position and look-at target each follow a uniform Catmull-Rom curve (C1 in its parameter); scroll progress u maps to the curve
// parameter through a monotone cubic (Fritsch-Carlson), so the camera speed is continuous across beat boundaries
// and never stops at one.
import { CatmullRomCurve3, Vector3 } from 'three';
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
}

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

/** Per-beat shots. Yaw 0 looks from +z towards -z; positive yaw swings the camera towards +x. */
const SHOTS: Record<BeatId, Shot> = {
  hero: { rect: (l) => l.bounds, zoom: 1.05, pitch: 36, yaw: 28, at: 0 },
  task: { rect: (l) => l.plot, zoom: 1.45, pitch: 52, yaw: 16, at: 0.6 },
  plan: { rect: (l) => l.plot, zoom: 1.25, pitch: 78, yaw: 6, at: 0.55 },
  lanes: { rect: (l) => union(l.plot, ...depotRects(l)), zoom: 1.0, pitch: 40, yaw: 30, at: 0.5 },
  verify: { rect: (l) => l.plot, zoom: 1.0, pitch: 38, yaw: 36, at: 0.5 },
  merge: { rect: (l) => union(l.plot, blockOr(l)), zoom: 0.95, pitch: 40, yaw: 18, at: 0.6 },
  review: { rect: (l) => union(blockOr(l), ...l.annex), zoom: 1.35, pitch: 36, yaw: 14, at: 0.5 },
  bill: { rect: (l) => l.bounds, zoom: 1.6, pitch: 46, yaw: 8, at: 1 },
};

/** Tallest a building can get (m): keeps tall lots in frame. Matches H_MAX in lots.ts loosely. */
const HEIGHT_MARGIN = 4;

/** Distance at which a rect (plus a height margin) fits the view for this aspect. */
function fitDistance(r: Rect, aspect: number, fovDeg: number): number {
  const radius = 0.5 * Math.hypot(r.w, r.d, HEIGHT_MARGIN);
  const v = (fovDeg * Math.PI) / 180;
  const h = 2 * Math.atan(Math.tan(v / 2) * aspect);
  return radius / Math.sin(Math.min(v, h) / 2);
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
    const u = b.id === 'hero' ? 0 : b.id === 'bill' ? 1 : b.u0 + (b.u1 - b.u0) * shot.at;
    if (keys.length && u <= keys[keys.length - 1].u + 1e-6) continue; // zero-length beat: keep the earlier pose
    const r = shot.rect(layout);
    const dist = fitDistance(r, a, fovDeg) * shot.zoom;
    const pitch = (shot.pitch * Math.PI) / 180;
    const yaw = (shot.yaw * Math.PI) / 180;
    const tx = r.x, tz = r.z, ty = 0.6;
    keys.push({
      beat: b.id,
      u,
      pos: [tx + dist * Math.cos(pitch) * Math.sin(yaw), ty + dist * Math.sin(pitch), tz + dist * Math.cos(pitch) * Math.cos(yaw)],
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

/** u snapped to the pose a static (reduced-motion / low tier) frame shows for the beat under u: late in the beat. */
export function beatPoseU(beats: Beat[], u: number, at = 0.85): number {
  const x = u <= 0 ? 0 : u >= 1 ? 1 : u;
  for (const b of beats) {
    if (b.u1 > b.u0 && x >= b.u0 && (x < b.u1 || b.u1 >= 1)) return b.id === 'hero' ? 0 : b.u0 + (b.u1 - b.u0) * at;
  }
  return x;
}
