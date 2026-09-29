// The walk route: a pure module (three maths only, no scene, no DOM) shared by the /lookdev walk bench and, later, the story.
// The camera stands on the globe, up = the local surface normal, and walks a street of ordinary (non-tower) cells from tower to
// tower in routing order (core, t1, domain, gates). The street is a shortest walk over free cells that prefers flat ground
// (Dijkstra), rounded with a Catmull-Rom curve, so it never crosses a tower. At each tower the camera stops on a neighbouring
// cell, turns to face it, then turns to the next leg's heading. Orientation is built from quaternions (right, up, back basis,
// then a pitch about `right`): no lookAt, no fixed world up, so the horizon can roll with the sphere.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { walkUOf } from './motion-config';
import type { Lattice } from './honeycomb';

export interface WalkParams {
  /** camera height above the local ground, world units */
  eye: number;
  /** 'env' (default): a smooth envelope that never dips below the actual column tops under the route, so a small camera never clips a column.
   *  'smooth': the blended column-top field (fine for a camera well above the columns) */
  ground?: 'env' | 'smooth';
  /** vertical FOV, degrees (passed through to the pose) */
  fov: number;
  /** degrees the view is tipped below the horizon */
  pitchDeg: number;
}

export interface WalkStop {
  name: string;
  band: string;
  /** route parameter range (0..1) the camera dwells at this stop */
  u0: number;
  u1: number;
  /** unit normal of the tower cell (the landmark) and of the cell the camera stands on */
  tower: Vector3;
  stand: Vector3;
}

export interface WalkPose {
  position: Vector3;
  quaternion: Quaternion;
  fov: number;
  up: Vector3;
  /** unit heading in the tangent plane, before pitch */
  forward: Vector3;
  /** ground under the camera, above the sphere */
  ground: number;
  /** index of the tower being approached (or dwelt at) */
  stop: number;
}

export interface WalkRoute {
  /** total route parameter length in world units (street length at globe radius, plus dwell allowances) */
  length: number;
  stops: WalkStop[];
  sample(u: number, p: WalkParams, out?: WalkPose): WalkPose;
  /** smoothed column top (above the sphere) in the direction `dir` */
  groundTop(dir: Vector3): number;
  /** unit direction of the route at parameter u (0..1), written to `out` */
  dirAt(u: number, out: Vector3): Vector3;
  /** globe cells (indices into lattice.cells) the street is made of; never a tower cell */
  pathCells(): number[];
}

const BAND_ORDER = ['core', 't1', 'domain', 'gate'] as const;
const DWELL = 4; // world units of route parameter spent turning at an ordinary stop (face the tower, then turn on)
const DWELL_BAND = 6; // ... at the last tower of a band
const HEADING_SIGMA = 10; // route units the heading is smoothed over (~ 3 cells): the walker turns gradually, never in a snap
const START_BACK = 0.6; // rad: the walk starts this far north (+Y) of the core cell
const SPAN_SAMPLES = 20; // Catmull-Rom samples per cell-to-cell span
const FLAT_COST = 3; // Dijkstra: extra cost per world unit of height change between neighbouring cells

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (t: number) => t * t * (3 - 2 * t);

type Seg = { kind: 'walk' | 'dwell'; i: number; s0: number; s1: number };
interface Chain { pts: Vector3[]; cum: number[]; tan: Vector3[]; len: number; cells: number[] }

export function createWalkRoute(lattice: Lattice): WalkRoute {
  const R = lattice.radius;
  const cells = lattice.cells;
  const globe = cells.filter((c) => !c.moon);

  // typical angle between neighbouring cell centres
  let sum = 0, n = 0;
  for (const c of globe) for (const j of c.neighbours) {
    const o = cells[j];
    if (o.moon) continue;
    sum += Math.acos(clamp(c.normal.dot(o.normal), -1, 1)); n++;
  }
  const spacing = sum / Math.max(1, n);
  const sigma = 0.6 * spacing;
  const cosCut = Math.cos(3 * sigma);

  function groundTop(dir: Vector3): number {
    let w = 0, h = 0;
    for (const c of globe) {
      const d = c.normal.dot(dir);
      if (d < cosCut) continue;
      const th = Math.acos(clamp(d, -1, 1)) / sigma;
      const k = Math.exp(-th * th);
      w += k; h += k * c.base;
    }
    return w > 0 ? h / w : 0;
  }

  const nearest = (d: Vector3): number => {
    let best = -1, bd = -2;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].moon) continue;
      const dd = cells[i].normal.dot(d);
      if (dd > bd) { bd = dd; best = i; }
    }
    return best;
  };

  // ---- tower order: bands in routing order; inside a band, nearest neighbour from the previous tower ----
  const towers: { name: string; band: string; cell: number }[] = [];
  const towerCell = new Set<number>();
  let prevDir = new Vector3(0, 0, 1);
  for (const band of BAND_ORDER) {
    const pool = cells.map((c, i) => i).filter((i) => !cells[i].moon && cells[i].agent?.band === band);
    // t1 keeps the stated routing order (explore, git-specialist, junior-dev = by name); larger bands go nearest-neighbour
    if (band === 't1') pool.sort((a, b) => cells[a].agent!.name.localeCompare(cells[b].agent!.name));
    while (pool.length) {
      let best = 0;
      if (band !== 't1') for (let k = 1; k < pool.length; k++) if (cells[pool[k]].normal.dot(prevDir) > cells[pool[best]].normal.dot(prevDir)) best = k;
      const ci = pool.splice(best, 1)[0];
      towers.push({ name: cells[ci].agent!.name, band, cell: ci });
      towerCell.add(ci);
      prevDir = cells[ci].normal;
    }
  }

  // ---- Dijkstra over free (non-tower, non-moon) cells; cost = distance x (1 + FLAT_COST x height change) ----
  const free = (i: number) => !cells[i].moon && !towerCell.has(i);
  function dijkstra(from: number): { dist: number[]; prev: number[] } {
    const dist = new Array<number>(cells.length).fill(Infinity), prev = new Array<number>(cells.length).fill(-1);
    const done = new Array<boolean>(cells.length).fill(false);
    dist[from] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < cells.length; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      done[u] = true;
      for (const v of cells[u].neighbours) {
        if (!free(v) || done[v]) continue;
        const ang = Math.acos(clamp(cells[u].normal.dot(cells[v].normal), -1, 1));
        const cost = ang * (1 + FLAT_COST * Math.abs(cells[u].base - cells[v].base));
        if (dist[u] + cost < dist[v]) { dist[v] = dist[u] + cost; prev[v] = u; }
      }
    }
    return { dist, prev };
  }
  const chainTo = (prev: number[], to: number): number[] => { const c: number[] = []; for (let k = to; k >= 0; k = prev[k]) c.push(k); return c.reverse(); };

  // start cell: the free cell nearest the point north of the core
  const startDir = new Vector3(0, Math.sin(START_BACK), Math.cos(START_BACK));
  let startCell = -1;
  { let bd = -2; cells.forEach((c, i) => { if (free(i) && c.normal.dot(startDir) > bd) { bd = c.normal.dot(startDir); startCell = i; } }); }

  // stand cell of each tower = the free neighbour nearest (by street cost) to where the walker is; the chain to it is the leg
  const stands: number[] = [];
  const chains: number[][] = [];
  let at = startCell;
  for (const t of towers) {
    const { dist, prev } = dijkstra(at);
    let best = -1, bd = Infinity;
    for (const v of cells[t.cell].neighbours) if (free(v) && dist[v] < bd) { bd = dist[v]; best = v; }
    if (best < 0) throw new Error(`walk: tower ${t.name} has no free neighbour`);
    chains.push(chainTo(prev, best));
    stands.push(best);
    at = best;
  }

  // ---- rounded curve through each chain (Catmull-Rom on the sphere, then re-normalised) ----
  const cr = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, t: number, out: Vector3) => {
    const t2 = t * t, t3 = t2 * t;
    out.set(0, 0, 0)
      .addScaledVector(p0, -0.5 * t3 + t2 - 0.5 * t)
      .addScaledVector(p1, 1.5 * t3 - 2.5 * t2 + 1)
      .addScaledVector(p2, -1.5 * t3 + 2 * t2 + 0.5 * t)
      .addScaledVector(p3, 0.5 * t3 - 0.5 * t2);
    return out.normalize();
  };
  const built: Chain[] = chains.map((ch) => {
    const cp = ch.map((i) => cells[i].normal);
    const pts: Vector3[] = [];
    if (cp.length === 1) pts.push(cp[0].clone(), cp[0].clone());
    else {
      for (let k = 0; k < cp.length - 1; k++) {
        const p0 = cp[Math.max(0, k - 1)], p1 = cp[k], p2 = cp[k + 1], p3 = cp[Math.min(cp.length - 1, k + 2)];
        for (let j = 0; j < SPAN_SAMPLES; j++) pts.push(cr(p0, p1, p2, p3, j / SPAN_SAMPLES, new Vector3()));
      }
      pts.push(cp[cp.length - 1].clone());
    }
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.acos(clamp(pts[k - 1].dot(pts[k]), -1, 1)) * R);
    const tan = pts.map((p, k) => {
      const a = pts[Math.max(0, k - 2)], b = pts[Math.min(pts.length - 1, k + 2)];
      const t = b.clone().sub(a);
      t.addScaledVector(p, -t.dot(p));
      return t.lengthSq() < 1e-12 ? new Vector3() : t.normalize();
    });
    // a chain with no length has no direction of its own: borrow the next non-empty one below
    return { pts, cum, tan, len: cum[cum.length - 1], cells: ch };
  });

  // ---- segments along the route parameter: walk the street to a stand cell, then dwell there facing the tower ----
  const segs: Seg[] = [];
  let s = 0;
  towers.forEach((t, i) => {
    const len = Math.max(0.001, built[i].len);
    segs.push({ kind: 'walk', i, s0: s, s1: s + len }); s += len;
    const lastOfBand = i === towers.length - 1 || towers[i + 1].band !== t.band;
    const dw = lastOfBand ? DWELL_BAND : DWELL;
    segs.push({ kind: 'dwell', i, s0: s, s1: s + dw }); s += dw;
  });
  const total = s;

  const stops: WalkStop[] = towers.map((t, i) => {
    const d = segs[2 * i + 1];
    return { name: t.name, band: t.band, u0: d.s0 / total, u1: d.s1 / total, tower: cells[t.cell].normal.clone(), stand: cells[stands[i]].normal.clone() };
  });

  // scratch
  const tmp = new Vector3(), tmp2 = new Vector3();
  const right = new Vector3(), back = new Vector3();
  const m = new Matrix4(), qBase = new Quaternion(), qPitch = new Quaternion();

  /** point and heading on a chain at arc length `a` from its start */
  function onChain(c: Chain, a: number, dirOut: Vector3, fwdOut: Vector3) {
    const x = clamp(a, 0, c.len);
    let lo = 0, hi = c.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c.cum[mid] <= x) lo = mid; else hi = mid; }
    const span = c.cum[hi] - c.cum[lo];
    const f = span > 1e-9 ? (x - c.cum[lo]) / span : 0;
    dirOut.copy(c.pts[lo]).lerp(c.pts[hi], f).normalize();
    fwdOut.copy(c.tan[lo]).lerp(c.tan[hi], f);
    fwdOut.addScaledVector(dirOut, -fwdOut.dot(dirOut));
    return fwdOut.lengthSq() > 1e-12 ? fwdOut.normalize() : fwdOut;
  }
  const headingIn = (i: number, out: Vector3) => {
    const c = built[i];
    onChain(c, c.len, tmp, out);
    if (out.lengthSq() < 1e-12) { // a zero-length street: face the tower's side
      out.copy(cells[towers[i].cell].normal).addScaledVector(tmp, -cells[towers[i].cell].normal.dot(tmp)).normalize();
    }
    return out;
  };
  /** position direction on the route at u and the heading it WANTS there (the street tangent while walking, toward the tower while dwelling); returns the stop index */
  function placeRaw(u: number, dirOut: Vector3, wantOut: Vector3): number {
    const S = clamp(u, 0, 1) * total;
    let k = 0;
    while (k < segs.length - 1 && S > segs[k].s1) k++;
    const sg = segs[k];
    const f = clamp((S - sg.s0) / (sg.s1 - sg.s0), 0, 1);
    const c = built[sg.i];
    if (sg.kind === 'walk') {
      onChain(c, smooth(f) * c.len, dirOut, wantOut); // eased: the camera starts and stops each street at rest
      if (wantOut.lengthSq() < 1e-12) headingIn(sg.i, wantOut);
    } else {
      onChain(c, c.len, dirOut, wantOut);
      wantOut.copy(cells[towers[sg.i].cell].normal);
      wantOut.addScaledVector(dirOut, -wantOut.dot(dirOut)).normalize();
    }
    dirOut.normalize();
    return sg.i;
  }

  // ---- heading: the wanted heading, low-passed along the route ----
  // Turning to face each tower and then the next street as separate quick turns swings the camera by up to 180 degrees over a few pixels of scroll.
  // Instead the wanted heading (as an angle about the local up, measured from a reference direction carried along the route) is unwrapped and
  // smoothed with a Gaussian of HEADING_SIGMA route units, so every turn is spread over many scroll steps. Stateless: a table over u.
  const HEAD_N = 4096;
  const headDir: Vector3[] = [], headRef: Vector3[] = [], headPsi: number[] = [];
  {
    const d = new Vector3(), want = new Vector3(), e = new Vector3(), side = new Vector3();
    let prev = 0;
    for (let i = 0; i <= HEAD_N; i++) {
      placeRaw(i / HEAD_N, d, want);
      if (i === 0) e.copy(want); else e.addScaledVector(d, -e.dot(d));
      if (e.lengthSq() < 1e-10) e.copy(want);
      e.normalize();
      side.crossVectors(d, e);
      let psi = Math.atan2(want.dot(side), want.dot(e));
      if (i > 0) psi += Math.PI * 2 * Math.round((prev - psi) / (Math.PI * 2)); // unwrap: no 2 pi jumps
      prev = psi;
      headDir.push(d.clone()); headRef.push(e.clone()); headPsi.push(psi);
    }
    const sig = (HEADING_SIGMA / total) * HEAD_N, rad = Math.ceil(3 * sig);
    const kern = Array.from({ length: 2 * rad + 1 }, (_, k) => Math.exp(-0.5 * ((k - rad) / sig) ** 2));
    const ks = kern.reduce((a, b) => a + b, 0);
    const sm = headPsi.map((_, i) => { let v = 0; for (let k = -rad; k <= rad; k++) v += headPsi[clamp(i + k, 0, HEAD_N)] * kern[k + rad]; return v / ks; });
    for (let i = 0; i <= HEAD_N; i++) headPsi[i] = sm[i];
  }
  const headAt = (u: number, dirNow: Vector3, out: Vector3): Vector3 => {
    const x = clamp(u, 0, 1) * HEAD_N, i = Math.min(HEAD_N - 1, Math.floor(x)), t = x - i;
    const psi = headPsi[i] + (headPsi[i + 1] - headPsi[i]) * t;
    tmp.copy(headRef[i]).lerp(headRef[i + 1], t);
    tmp.addScaledVector(dirNow, -tmp.dot(dirNow)).normalize();
    tmp2.crossVectors(dirNow, tmp);
    return out.copy(tmp).multiplyScalar(Math.cos(psi)).addScaledVector(tmp2, Math.sin(psi)).normalize();
  };

  const want = new Vector3();
  /** position direction and heading on the route at u (both unit, heading in the tangent plane); returns the stop index */
  function place(u: number, dirOut: Vector3, fwdOut: Vector3): number {
    const stop = placeRaw(u, dirOut, want);
    headAt(u, dirOut, fwdOut);
    return stop;
  }

  // ---- ground envelope along the route ----
  // The true column top under the route (the nearest cell's own height), widened by a max filter each way, then rounded by a
  // Gaussian narrower than that window, so the curve is smooth AND never below the columns the camera passes over.
  const ENV_N = 4096;
  const env: number[] = (() => {
    const cellUnits = R * spacing; // world units per cell spacing
    const win = Math.max(1, Math.round((0.75 * cellUnits * ENV_N) / total)); // samples each way
    const raw: number[] = [];
    const d = new Vector3(), f = new Vector3();
    for (let i = 0; i <= ENV_N; i++) {
      place(i / ENV_N, d, f);
      raw.push(cells[nearest(d)].base);
    }
    const wide = raw.map((_, i) => { let mx = 0; for (let k = -win; k <= win; k++) mx = Math.max(mx, raw[clamp(i + k, 0, ENV_N)]); return mx; });
    const sig = Math.max(1, win * 0.4), rad = Math.ceil(3 * sig);
    const kern = Array.from({ length: 2 * rad + 1 }, (_, k) => Math.exp(-0.5 * ((k - rad) / sig) ** 2));
    const ks = kern.reduce((a, b) => a + b, 0);
    return wide.map((_, i) => { let v = 0; for (let k = -rad; k <= rad; k++) v += wide[clamp(i + k, 0, ENV_N)] * kern[k + rad]; return Math.max(v / ks, raw[i]) + 0.02; });
  })();
  const envAt = (u: number) => {
    const x = clamp(u, 0, 1) * ENV_N, i = Math.min(ENV_N - 1, Math.floor(x));
    return env[i] + (env[i + 1] - env[i]) * (x - i);
  };

  const fresh = (): WalkPose => ({ position: new Vector3(), quaternion: new Quaternion(), fov: 50, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 });
  const dir = new Vector3(), fwd = new Vector3();

  return {
    length: total,
    stops,
    groundTop,
    dirAt(u, out) { place(u, out, fwd); return out; },
    pathCells() {
      const seen = new Set<number>();
      built.forEach((c) => c.cells.forEach((i) => seen.add(i)));
      return [...seen];
    },
    sample(u, p, out = fresh()) {
      const stop = place(u, dir, fwd);
      const ground = p.ground === 'smooth' ? groundTop(dir) : envAt(u);
      out.ground = ground;
      out.position.copy(dir).multiplyScalar(R + ground + p.eye);
      out.up.copy(dir);
      out.forward.copy(fwd);
      right.crossVectors(fwd, dir).normalize();
      back.copy(fwd).negate();
      qBase.setFromRotationMatrix(m.makeBasis(right, dir, back));
      qPitch.setFromAxisAngle(right, -(p.pitchDeg * Math.PI) / 180);
      out.quaternion.copy(qPitch).multiply(qBase);
      out.fov = p.fov;
      out.stop = stop;
      return out;
    },
  };
}

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
 * (a straight lerp between the far spline pose and a pose on the ground would cut through the globe), orientation by quaternion slerp, FOV by lerp.
 * Writes outPos and outQuat; returns the blended FOV. At w = 0 it returns the spline pose exactly, at w = 1 the walker's.
 */
export function blendWalkPose(
  posA: Vector3, quatA: Quaternion, fovA: number, posB: Vector3, quatB: Quaternion, fovB: number, base: Quaternion, w: number, outPos: Vector3, outQuat: Quaternion,
): number {
  const rA = posA.length(), rB = posB.length();
  const dA = posA.clone().divideScalar(rA), dB = posB.clone().divideScalar(rB);
  const cos = clamp(dA.dot(dB), -1, 1), ang = Math.acos(cos), sin = Math.sin(ang);
  if (sin < 1e-6) outPos.copy(dA);
  else outPos.copy(dA).multiplyScalar(Math.sin((1 - w) * ang) / sin).addScaledVector(dB, Math.sin(w * ang) / sin);
  outPos.normalize().multiplyScalar(rA + (rB - rA) * w);
  blendOrientation(quatA, quatB, base, w, outQuat);
  return fovA + (fovB - fovA) * w;
}

const _lookM = new Matrix4(), _up = new Vector3(0, 1, 0);
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
  route: WalkRoute, sampleSpline: (p: number, pos: Vector3, target: Vector3) => void, ranges: readonly (readonly [number, number])[], cfg: { eye: number; fov: number; pitchDeg: number },
): Quaternion {
  const qs: Quaternion[] = [], pos = new Vector3(), tgt = new Vector3(), wk: WalkPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 0, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 };
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
const _walkScratch: WalkPose = { position: new Vector3(), quaternion: new Quaternion(), fov: 40, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 };

/**
 * The story camera while the walk weight `w` is above zero: the spline pose (position `splinePos`, looking at `splineTarget`, FOV 40) blended into the
 * walker at Cells chapter progress `chapterProgress`. The world calls this every frame and scripts/smoothness-check.mjs samples the same function,
 * so what is verified is what ships. Writes outPos/outQuat, returns the FOV; `walker` receives the walker's own pose (its up/forward drive the lights).
 */
export function walkCameraPose(
  route: WalkRoute, base: Quaternion, splinePos: Vector3, splineTarget: Vector3, w: number, chapterProgress: number,
  cfg: { eye: number; fov: number; pitchDeg: number }, outPos: Vector3, outQuat: Quaternion, walker: WalkPose = _walkScratch,
): number {
  _lookM.lookAt(splinePos, splineTarget, _up); // the same orientation Object3D.lookAt gives a camera
  _qSpline.setFromRotationMatrix(_lookM);
  route.sample(walkUOf(chapterProgress), cfg, walker);
  return blendWalkPose(splinePos, _qSpline, 40, walker.position, walker.quaternion, cfg.fov, base, w, outPos, outQuat);
}
