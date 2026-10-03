// The camera maths shared by the story (world.ts) and the /lookdev walk bench: the pose types the follow route fills (follow.ts), the dive/rise blend between the spline camera and the
// follow camera (blendWalkPose, walkBlendBase, walkCameraPose), the horizon helpers (fog, visibility over the globe), the tower card choice and drag-to-look. Pure: three maths only.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { walkUOf } from './motion-config';
import type { Route } from './routes';

export interface WalkParams {
  /** vertical FOV, degrees (passed through to the pose) */
  fov: number;
}

export interface WalkStop {
  name: string;
  band: string;
  /** route parameter range (0..1): the comet lands on this tower at u0 and leaves at u1 (the hold) */
  u0: number;
  u1: number;
}

export interface WalkPose {
  position: Vector3;
  quaternion: Quaternion;
  fov: number;
  up: Vector3;
  /** unit heading in the tangent plane */
  forward: Vector3;
  /** index of the tower the comet is heading for (or resting on) */
  stop: number;
}

export interface WalkRoute {
  /** total route parameter length in route units (walkCfg.rate of them pass per second under autoplay) */
  length: number;
  stops: WalkStop[];
  sample(u: number, p: WalkParams, out?: WalkPose): WalkPose;
  /** the comet's path (cap to cap) and the distance along it at route parameter u */
  cometRoute: Route;
  cometDist(u: number): number;
}

/** A tower the route visits, by agent name, and how long the comet holds there (default walkCfg.dwellSec). */
export interface WalkStopSpec { name: string; holdSec?: number }

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/** Ground distance to the horizon for a camera `camDist` from the globe centre: the tangent length sqrt(camDist^2 - R^2) (= sqrt(2 R h + h^2) at altitude h). */
export function horizonDistance(R: number, camDist: number): number {
  return Math.sqrt(Math.max(0, camDist * camDist - R * R));
}

/** Fog for the walker: near/far as multiples of the horizon distance, so the limb fades out instead of ending in a hard edge. */
export function horizonFog(R: number, camDist: number, nearK: number, farK: number): { near: number; far: number } {
  const d = horizonDistance(R, camDist);
  return { near: Math.max(0.05, d * nearK), far: Math.max(0.5, d * farK) };
}

/** Is `point` visible from `cam` over a globe of radius `R`? The segment cam -> point must clear the sphere (pure; used to hide label cards of towers past the horizon). */
export function visibleOverGlobe(cam: Vector3, point: Vector3, R: number): boolean {
  const dx = point.x - cam.x, dy = point.y - cam.y, dz = point.z - cam.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-12) return true;
  const t = clamp(-(cam.x * dx + cam.y * dy + cam.z * dz) / l2, 0, 1);
  const x = cam.x + dx * t, y = cam.y + dy * t, z = cam.z + dz * t;
  return x * x + y * y + z * z >= R * R;
}

/**
 * Blend the spline camera into the walker with ONE weight `w` (the walk weight): direction by slerp about the globe centre and distance by lerp
 * (a straight lerp between the far spline pose and a pose on the ground would cut through the globe), FOV by lerp. The orientation is a look-at whose view
 * direction runs from `targetA` (the spline's look-at target, seen from the blended position) to the walker's heading, with a roll reference that turns from
 * the world's up to the walker's frame (`upB` = the walker's up); without them it falls back to a rotation blend about `base`.
 * Writes outPos and outQuat; returns the blended FOV. At w = 0 it returns the spline pose exactly, at w = 1 the walker's.
 */
export function blendWalkPose(
  posA: Vector3, quatA: Quaternion, fovA: number, posB: Vector3, quatB: Quaternion, fovB: number, base: Quaternion, w: number, outPos: Vector3, outQuat: Quaternion, targetA?: Vector3, upB?: Vector3,
): number {
  const rA = posA.length(), rB = posB.length();
  const dA = posA.clone().divideScalar(rA), dB = posB.clone().divideScalar(rB);
  const cos = clamp(dA.dot(dB), -1, 1), ang = Math.acos(cos), sin = Math.sin(ang);
  if (sin < 1e-6) outPos.copy(dA);
  else outPos.copy(dA).multiplyScalar(Math.sin((1 - w) * ang) / sin).addScaledVector(dB, Math.sin(w * ang) / sin);
  outPos.normalize().multiplyScalar(rA + (rB - rA) * w);
  // The spline half of the orientation blend keeps looking at the spline's own target (a point on the globe) from where the camera now is, so the view stays on the globe as the
  // camera descends instead of sweeping off into empty sky (the spline's orientation, from a position it has left, no longer points at it). The walker's half takes over late (smootherstep).
  const sw = clamp((w - 0.5) / 0.48, 0, 1); // (the direction swing runs over the upper half of the descent; with a slerp it is safe that wide)
  const s = sw * sw * sw * (sw * (sw * 6 - 15) + 10);
  if (upB && targetA) {
    // Not a blend of two orientations (a rotation blend passes through views that look away from the globe altogether, half way down; a slerp flips where the two are nearly opposite) but
    // one look-at whose view DIRECTION turns from "towards the spline's target, from where the camera now is" to the walker's heading (a normalised lerp, late in the descent: smootherstep over
    // its lower part) and whose roll reference moves from the world's up to the walker's own frame: the walker's heading while the view is steep (looking straight down the surface normal, which
    // the dive passes close to, any radial up is degenerate), the walker's up once it is level. At w = 0 it is the spline's own look-at and at w = 1 exactly the walker's orientation.
    _fA.copy(targetA).sub(outPos).normalize();
    _fB.set(0, 0, -1).applyQuaternion(quatB);
    // the direction turns from fA to fB by a fraction s of the swing (a rotation about their common perpendicular: a normalised lerp collapses where the two are nearly opposite)
    _qSwing.setFromUnitVectors(_fA, _fB);
    _qFrac.identity().slerp(_qSwing, s);
    _fS.copy(_fA).applyQuaternion(_qFrac);
    if (_fS.lengthSq() > 1e-12) {
      _fS.normalize();
      // roll: the reference is the world's up at the start and the walker's frame at the end, and they can be nearly opposite, so the two are not mixed (the mix collapses to zero) but turned
      // into one another about the view axis. The turn is a signed angle d about the view axis; its branch is centred on d1, the angle at the end of the descent (where the view is the
      // walker's heading, known from the route alone), so d never crosses a branch cut on the way down however the route ends, and at w = 1 it is the shortest turn onto the walker's roll.
      _yp.copy(_up).addScaledVector(_fS, -_up.dot(_fS));
      _upRef.copy(_fB).multiplyScalar(1 - s).addScaledVector(upB, s);
      _upRef.addScaledVector(_fS, -_upRef.dot(_fS));
      _y1.copy(_up).addScaledVector(_fB, -_up.dot(_fB));
      _u1.copy(upB).addScaledVector(_fB, -upB.dot(_fB));
      if (_yp.lengthSq() > 1e-10 && _upRef.lengthSq() > 1e-10) {
        _yp.normalize(); _upRef.normalize();
        const raw = Math.atan2(_tmpV.crossVectors(_yp, _upRef).dot(_fS), _yp.dot(_upRef));
        const d1 = _y1.lengthSq() > 1e-10 && _u1.lengthSq() > 1e-10 ? Math.atan2(_tmpV.crossVectors(_y1.normalize(), _u1.normalize()).dot(_fB), _y1.dot(_u1)) : 0;
        const d = d1 + (raw - d1) - Math.PI * 2 * Math.round((raw - d1) / (Math.PI * 2));
        const m = clamp((w - 0.1) / 0.75, 0, 1), roll = d * (m * m * (3 - 2 * m));
        _upRef.copy(_yp).multiplyScalar(Math.cos(roll)).addScaledVector(_tmpV.crossVectors(_fS, _yp), Math.sin(roll));
        _tmpV.copy(_fS).add(outPos);
        _lookM.lookAt(outPos, _tmpV, _upRef);
        outQuat.setFromRotationMatrix(_lookM);
        return fovA + (fovB - fovA) * w;
      }
    }
  }
  blendOrientation(quatA, quatB, base, s, outQuat);
  return fovA + (fovB - fovA) * w;
}

const _lookM = new Matrix4(), _up = new Vector3(0, 1, 0), _qSwing = new Quaternion(), _qFrac = new Quaternion();
const _fA = new Vector3(), _fB = new Vector3(), _fS = new Vector3(), _upRef = new Vector3(), _yp = new Vector3(), _tmpV = new Vector3(), _y1 = new Vector3(), _u1 = new Vector3();
const _bInv = new Quaternion(), _rA = new Quaternion(), _rB = new Quaternion(), _va = new Vector3(), _vb = new Vector3();
/** rotation vector (axis x angle, angle in [0, pi]) of the rotation `q` relative to `base` */
function rotVec(base: Quaternion, q: Quaternion, out: Vector3): Vector3 {
  _bInv.copy(base).invert();
  _rA.copy(_bInv).multiply(q);
  if (_rA.w < 0) { _rA.x = -_rA.x; _rA.y = -_rA.y; _rA.z = -_rA.z; _rA.w = -_rA.w; }
  const half = Math.acos(Math.min(1, _rA.w)), s = Math.sin(half);
  return s < 1e-9 ? out.set(0, 0, 0) : out.set(_rA.x, _rA.y, _rA.z).multiplyScalar((2 * half) / s);
}
/**
 * Orientation blend for the dive and the rise: both orientations are written as rotation vectors about a fixed `base` orientation and the vectors are blended.
 * A quaternion slerp between the spline camera and the walker is discontinuous where the two are exactly 180 degrees apart (the shortest arc flips), and
 * they get within 8 degrees of that (172); an up-vector blend goes degenerate; a frame that follows the position still meets the 180. About a base that both
 * stay well clear of (see walkBlendBase, 147 degrees at most) the blend is smooth everywhere, and it is exactly quatA at w = 0 and quatB at w = 1.
 */
export function blendOrientation(quatA: Quaternion, quatB: Quaternion, base: Quaternion, w: number, out: Quaternion): Quaternion {
  rotVec(base, quatA, _va);
  rotVec(base, quatB, _vb);
  _va.multiplyScalar(1 - w).addScaledVector(_vb, w);
  const ang = _va.length();
  if (ang < 1e-9) return out.copy(base);
  _rB.setFromAxisAngle(_va.multiplyScalar(1 / ang), ang);
  return out.copy(base).multiply(_rB);
}

/**
 * The base orientation for blendOrientation: the sampled camera orientation (spline or walker, over the Cells progress ranges where the weight is between 0 and 1)
 * that minimises the largest angle to all the others. `sampleSpline(p, pos, target)` gives the spline camera at Cells progress p.
 */
export function walkBlendBase(
  route: WalkRoute, sampleSpline: (p: number, pos: Vector3, target: Vector3) => void, ranges: readonly (readonly [number, number])[], cfg: WalkParams,
): Quaternion {
  const qs: Quaternion[] = [], pos = new Vector3(), tgt = new Vector3(), wk: WalkPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 0, up: new Vector3(), forward: new Vector3(), stop: 0 };
  for (const [a, b] of ranges) for (let k = 0; k <= 24; k++) {
    const p = a + ((b - a) * k) / 24;
    sampleSpline(p, pos, tgt);
    _lookM.lookAt(pos, tgt, _up);
    qs.push(new Quaternion().setFromRotationMatrix(_lookM));
    route.sample(walkUOf(p), cfg, wk);
    qs.push(wk.quaternion.clone());
  }
  const angle = (x: Quaternion, y: Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(x.dot(y))));
  let best = qs[0], bv = Infinity;
  for (const c of qs) { let m = 0; for (const q of qs) m = Math.max(m, angle(c, q)); if (m < bv) { bv = m; best = c; } }
  return best.clone();
}

export interface TowerRef { name: string; top: Vector3 }

/** The tower whose card the walker sees: the nearest one in front of the camera, above the horizon, within `maxDist`. The one already shown (`current`) keeps
 *  the card unless another is at least 20% closer, so neighbours do not flicker. Pure. */
export function nearestTowerAhead(towers: TowerRef[], camPos: Vector3, camFwd: Vector3, R: number, current: string | null, maxDist = 7): string | null {
  let best: TowerRef | null = null, bd = maxDist, curD = Infinity;
  const dv = new Vector3();
  for (const t of towers) {
    dv.copy(t.top).sub(camPos);
    const d = dv.length();
    if (d > maxDist || dv.dot(camFwd) / d < 0.3 || !visibleOverGlobe(camPos, t.top, R + 0.3)) continue;
    if (t.name === current) curD = d;
    if (d < bd) { bd = d; best = t; }
  }
  if (best && current && best.name !== current && curD < bd * 1.2) return current;
  return best ? best.name : null;
}

const _qSpline = new Quaternion();
const _walkScratch: WalkPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 40, up: new Vector3(), forward: new Vector3(), stop: 0 };

/**
 * The story camera while the walk weight `w` is above zero: the spline pose (position `splinePos`, looking at `splineTarget`, FOV 40) blended into the
 * follow camera at Cells chapter progress `chapterProgress`. The world calls this every frame and scripts/smoothness-check.mjs samples the same function,
 * so what is verified is what ships. Writes outPos/outQuat, returns the FOV; `walker` receives the walker's own pose (its up/forward drive the lights).
 */
export function walkCameraPose(
  route: WalkRoute, base: Quaternion, splinePos: Vector3, splineTarget: Vector3, w: number, chapterProgress: number,
  cfg: WalkParams, outPos: Vector3, outQuat: Quaternion, walker: WalkPose = _walkScratch,
): number {
  _lookM.lookAt(splinePos, splineTarget, _up); // the same orientation Object3D.lookAt gives a camera
  _qSpline.setFromRotationMatrix(_lookM);
  route.sample(walkUOf(chapterProgress), cfg, walker);
  return blendWalkPose(splinePos, _qSpline, 40, walker.position, walker.quaternion, walker.fov, base, w, outPos, outQuat, splineTarget, walker.up);
}

const _lookYaw = new Quaternion(), _lookPitch = new Quaternion(), _lookOut = new Quaternion(), _axisX = new Vector3(1, 0, 0);
/** Turn the walker's head: `yaw` about the walker's up (world), `pitch` about the camera's own right, both scaled by `fade` (0 = untouched). Writes `out` (may be `q`). */
export function applyWalkLook(q: Quaternion, up: Vector3, yaw: number, pitch: number, fade: number, out: Quaternion): Quaternion {
  if (fade <= 0 || (yaw === 0 && pitch === 0)) return out.copy(q);
  _lookYaw.setFromAxisAngle(up, yaw * fade);
  _lookPitch.setFromAxisAngle(_axisX, pitch * fade);
  _lookOut.copy(_lookYaw).multiply(q).multiply(_lookPitch); // (through a scratch: `out` may be `q` itself)
  return out.copy(_lookOut);
}
