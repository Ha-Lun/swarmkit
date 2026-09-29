// The walk route: a pure module (three maths only, no scene, no DOM) shared by the /lookdev walk bench and, later, the story.
// The camera stands on the globe, up = the local surface normal, and walks a street of ordinary (non-tower) cells from tower to
// tower in routing order (core, t1, domain, gates). The street is a shortest walk over free cells that prefers flat ground
// (Dijkstra), rounded with a Catmull-Rom curve, so it never crosses a tower. At each tower the camera stops on a neighbouring
// cell, turns to face it, then turns to the next leg's heading. Orientation is built from quaternions (right, up, back basis,
// then a pitch about `right`): no lookAt, no fixed world up, so the horizon can roll with the sphere.
import { Matrix4, Quaternion, Vector3 } from 'three';
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
  const tmp = new Vector3(), tmp2 = new Vector3(), hIn = new Vector3(), hFace = new Vector3(), hOut = new Vector3();
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
  const headingOut = (i: number, out: Vector3) => {
    onChain(built[i], 0, tmp, out);
    if (out.lengthSq() < 1e-12) { // already standing at the next stand cell: the street is empty, so the next heading is toward its tower
      const tn = cells[towers[i].cell].normal;
      out.copy(tn).addScaledVector(tmp, -tn.dot(tmp)).normalize();
    }
    return out;
  };
  const signedAngle = (a: Vector3, b: Vector3, up: Vector3) => Math.atan2(tmp2.crossVectors(a, b).dot(up), a.dot(b));
  const rotate = (h: Vector3, up: Vector3, ang: number, out: Vector3) => {
    tmp2.crossVectors(up, h);
    return out.copy(h).multiplyScalar(Math.cos(ang)).addScaledVector(tmp2, Math.sin(ang));
  };

  /** position direction and heading on the route at u (both unit, heading in the tangent plane); returns the stop index */
  function place(u: number, dirOut: Vector3, fwdOut: Vector3): number {
    const S = clamp(u, 0, 1) * total;
    let k = 0;
    while (k < segs.length - 1 && S > segs[k].s1) k++;
    const sg = segs[k];
    const f = clamp((S - sg.s0) / (sg.s1 - sg.s0), 0, 1);
    if (sg.kind === 'walk') {
      const c = built[sg.i];
      onChain(c, smooth(f) * c.len, dirOut, fwdOut); // eased: the camera starts and stops each street at rest
      if (fwdOut.lengthSq() < 1e-12) headingIn(sg.i, fwdOut);
    } else {
      const c = built[sg.i];
      onChain(c, c.len, dirOut, hIn);
      if (hIn.lengthSq() < 1e-12) headingIn(sg.i, hIn);
      // face the tower (the direction from this cell toward the tower's cell, in the tangent plane) ...
      hFace.copy(cells[towers[sg.i].cell].normal);
      hFace.addScaledVector(dirOut, -hFace.dot(dirOut)).normalize();
      // ... then turn to the heading of the next street (or stay facing the tower at the end)
      if (sg.i + 1 < built.length) headingOut(sg.i + 1, hOut); else hOut.copy(hFace);
      if (hOut.lengthSq() < 1e-12) hOut.copy(hFace);
      const a1 = signedAngle(hIn, hFace, dirOut) * smooth(clamp(f / 0.45, 0, 1));
      const a2 = signedAngle(hFace, hOut, dirOut) * smooth(clamp((f - 0.55) / 0.45, 0, 1));
      rotate(hIn, dirOut, a1 + a2, fwdOut);
    }
    dirOut.normalize();
    fwdOut.addScaledVector(dirOut, -fwdOut.dot(dirOut)).normalize(); // keep the heading exactly in the tangent plane
    return sg.i;
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
