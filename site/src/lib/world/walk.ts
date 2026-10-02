// The walk route: a pure module (three maths only, no scene, no DOM) shared by the /lookdev walk bench and, later, the story.
// The camera stands on the globe, up = the local surface normal, and walks a street of ordinary (non-tower) cells from tower to
// tower in routing order (core, t1, domain, gates). The street is a shortest walk over free cells that prefers flat ground
// (Dijkstra), rounded with a Catmull-Rom curve, so it never crosses a tower. At each tower the camera stops on a neighbouring
// cell, turns to face it, then turns to the next leg's heading. Orientation is built from quaternions (right, up, back basis,
// then a pitch about `right`): no lookAt, no fixed world up, so the horizon can roll with the sphere.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { walkCfg, walkUOf } from './motion-config';
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
  /** unit normal of the tower cell (the landmark) */
  tower: Vector3;
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
  /** total route parameter length in route units (walkCfg.rate of them pass per second under autoplay): the streets stretched by walkCfg.legStretch, plus the holds */
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

const HEADING_SIGMA = 0.004; // fraction of the route the heading is lightly rounded over (a couple of route units): the turns themselves are the ramps of walkCfg.turnSecQuarter
const START_BACK = 0.6; // rad: the walk starts this far north (+Y) of the core cell
const SPAN_SAMPLES = 20; // Catmull-Rom samples per cell-to-cell span
const FLAT_COST = 3; // Dijkstra: extra cost per world unit of height change between neighbouring cells

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (t: number) => t * t * (3 - 2 * t);

type Seg = { kind: 'walk' | 'dwell'; i: number; s0: number; s1: number };
interface Chain { pts: Vector3[]; cum: number[]; tan: Vector3[]; len: number; cells: number[]; /** arc length at which the walker stops, holdBack short of the end */ stop: number }

/** A tower the route visits, by agent name, and how long the walker holds there (default walkCfg.dwellSec). */
export interface WalkStopSpec { name: string; holdSec?: number }

/** The route: a start on the street north of the core, then each `visit` tower in order, the first being the core. */
export function createWalkRoute(lattice: Lattice, visit: WalkStopSpec[]): WalkRoute {
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

  // ---- the towers to visit, in the order given; every tower (stop or not) is an obstacle the street goes round ----
  const towers: { name: string; band: string; cell: number; holdSec?: number }[] = [];
  const towerCell = new Set<number>();
  cells.forEach((c, i) => { if (!c.moon && c.agent) towerCell.add(i); });
  for (const sp of visit) {
    const ci = cells.findIndex((c) => !c.moon && c.agent?.name === sp.name);
    if (ci < 0) throw new Error(`walk: no tower for ${sp.name}`);
    towers.push({ name: sp.name, band: cells[ci].agent!.band, cell: ci, holdSec: sp.holdSec });
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
  // The walker stops walkCfg.holdBack world units short of the stand cell (not on it, 1.7 units from the tower: one slab would fill the frame), far enough off to see the whole pillar.
  // So each leg starts where the last one stopped: its curve begins with the tail of the previous one, from that stop to the stand cell, and goes on from there.
  const finish = (pts: Vector3[], cellsOf: number[]): Chain => {
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.acos(clamp(pts[k - 1].dot(pts[k]), -1, 1)) * R);
    const tan = pts.map((p, k) => {
      const a = pts[Math.max(0, k - 2)], b = pts[Math.min(pts.length - 1, k + 2)];
      const t = b.clone().sub(a);
      t.addScaledVector(p, -t.dot(p));
      return t.lengthSq() < 1e-12 ? new Vector3() : t.normalize();
    });
    const len = cum[cum.length - 1];
    // a chain with no length has no direction of its own: the walkers borrow (see headingIn)
    return { pts, cum, tan, len, cells: cellsOf, stop: Math.max(0, len - walkCfg.holdBack) };
  };
  const built: Chain[] = [];
  chains.forEach((ch, k) => {
    const cp = ch.map((i) => cells[i].normal.clone());
    if (k > 0) { // this leg starts where the last one stopped (holdBack short of its stand cell), and the curve runs on through that stand cell: one rounded curve, no corner at it
      const pc = built[k - 1], x = pc.stop;
      let lo = 0; while (lo < pc.cum.length - 2 && pc.cum[lo + 1] <= x) lo++;
      const span = pc.cum[lo + 1] - pc.cum[lo], f = span > 1e-9 ? (x - pc.cum[lo]) / span : 0;
      cp.unshift(pc.pts[lo].clone().lerp(pc.pts[lo + 1], f).normalize());
    }
    const pts: Vector3[] = [];
    if (cp.length === 1) pts.push(cp[0].clone(), cp[0].clone());
    else {
      for (let j = 0; j < cp.length - 1; j++) {
        const p0 = cp[Math.max(0, j - 1)], p1 = cp[j], p2 = cp[j + 1], p3 = cp[Math.min(cp.length - 1, j + 2)];
        for (let q = 0; q < SPAN_SAMPLES; q++) pts.push(cr(p0, p1, p2, p3, q / SPAN_SAMPLES, new Vector3()));
      }
      pts.push(cp[cp.length - 1].clone());
    }
    built.push(finish(pts, ch));
  });

  // ---- segments along the route parameter: walk the street to a stand cell, then dwell there facing the tower ----
  const segs: Seg[] = [];
  let s = 0;
  towers.forEach((t, i) => {
    const len = Math.max(0.001, built[i].stop) * walkCfg.legStretch;
    segs.push({ kind: 'walk', i, s0: s, s1: s + len }); s += len;
    const dw = (t.holdSec ?? walkCfg.dwellSec) * walkCfg.rate; // route units held at the tower (motion-config walkCfg)
    segs.push({ kind: 'dwell', i, s0: s, s1: s + dw }); s += dw;
  });
  const total = s;

  const stops: WalkStop[] = towers.map((t, i) => {
    const d = segs[2 * i + 1];
    return { name: t.name, band: t.band, u0: d.s0 / total, u1: d.s1 / total, tower: cells[t.cell].normal.clone() };
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
    onChain(c, c.stop, tmp, out);
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
      onChain(c, smooth(f) * c.stop, dirOut, wantOut); // eased: the camera starts and stops each street at rest
      if (wantOut.lengthSq() < 1e-12) headingIn(sg.i, wantOut);
    } else {
      onChain(c, c.stop, dirOut, wantOut);
      wantOut.copy(cells[towers[sg.i].cell].normal);
      wantOut.addScaledVector(dirOut, -wantOut.dot(dirOut)).normalize();
    }
    dirOut.normalize();
    return sg.i;
  }

  // ---- how long each turn takes: walkCfg.turnSecQuarter seconds per 90 degrees, so a small turn is quick and a half turn is not a whip ----
  // tin[i]: from the way the street arrives to the tower; tout[i]: from the tower to the way the next street sets off (0 after the last tower)
  const tin: number[] = [], tout: number[] = [];
  {
    const A = new Vector3(), B = new Vector3(), Tw = new Vector3(), D = new Vector3();
    const units = (ang: number) => clamp(walkCfg.turnSecQuarter * (ang / (Math.PI / 2)), walkCfg.turnMinSec, walkCfg.turnMaxSec) * walkCfg.rate;
    const proj = (n: Vector3, d: Vector3, out: Vector3) => out.copy(n).addScaledVector(d, -n.dot(d)).normalize();
    towers.forEach((t, i) => {
      onChain(built[i], built[i].stop, D, tmp2); // where the walker holds (holdBack short of the stand cell)
      proj(cells[t.cell].normal, D, Tw);
      headingIn(i, A);
      tin.push(units(Math.acos(clamp(A.dot(Tw), -1, 1))));
      if (i + 1 < towers.length) {
        onChain(built[i + 1], 0, tmp, B);
        if (B.lengthSq() < 1e-12) B.copy(cells[towers[i + 1].cell].normal);
        proj(B, D, B);
        tout.push(units(Math.acos(clamp(Tw.dot(B), -1, 1))));
      } else tout.push(0);
    });
  }

  // ---- heading: face the street while walking, face the tower for the hold, turn on to the next street ----
  // Two wanted headings run along the route: the street (its tangent while walking; during a hold, the tangent the NEXT street starts with) and the tower. A focus weight
  // f blends from the one to the other by the shortest turn: it ramps up over the turn's duration (walkCfg.turnSecQuarter per 90 degrees, tin) at the end of the walk to a tower (finishing inside the hold when the street
  // is short), stays 1 through the hold, and ramps down over the last turn (tout) of the hold, so the walker is turning to the next street while it sets off. The angle (about
  // the local up, measured from a reference direction carried along the route) is unwrapped and given a light Gaussian, so a turn never snaps. Stateless: a table over u.
  const wrapPi = (a: number) => a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
  const HEAD_N = 4096;
  /** a gaussian over a table of HEAD_N + 1 samples along the route, `sigUnits` route units wide */
  const gauss = (arr: number[], sigUnits: number) => {
    const sig = Math.max(1e-3, (sigUnits / total) * HEAD_N), rad = Math.ceil(3 * sig);
    const kern = Array.from({ length: 2 * rad + 1 }, (_, k) => Math.exp(-0.5 * ((k - rad) / sig) ** 2));
    const ks = kern.reduce((x, y) => x + y, 0);
    return arr.map((_, i) => { let v = 0; for (let k = -rad; k <= rad; k++) v += arr[clamp(i + k, 0, HEAD_N)] * kern[k + rad]; return v / ks; });
  };
  const headStop: number[] = [];
  const headDir: Vector3[] = [], headRef: Vector3[] = [], headPsi: number[] = [], headFocus: number[] = [], headZoom: number[] = [];
  {
    const d = new Vector3(), wantS = new Vector3(), wantT = new Vector3(), e = new Vector3(), side = new Vector3();
    const psiS: number[] = [], psiT: number[] = [];
    let prevS = 0, prevT = 0, k = 0;
    for (let i = 0; i <= HEAD_N; i++) {
      const S = (i / HEAD_N) * total;
      placeRaw(i / HEAD_N, d, wantS); // the street tangent while walking, the tower while holding
      while (k < segs.length - 1 && S > segs[k].s1) k++;
      const sg = segs[k], ti = sg.i;
      wantT.copy(cells[towers[ti].cell].normal).addScaledVector(d, -cells[towers[ti].cell].normal.dot(d));
      if (wantT.lengthSq() < 1e-12) wantT.copy(wantS); else wantT.normalize();
      let f: number;
      const walkSeg = segs[2 * ti];
      const ws = walkSeg.s1 - Math.min(tin[ti] * 0.5, walkSeg.s1 - walkSeg.s0); // the turn to the tower starts this far before the street ends
      const fin = smooth(clamp((S - ws) / tin[ti], 0, 1));
      if (sg.kind === 'walk') f = fin;
      else {
        const lastDwell = ti === towers.length - 1;
        if (!lastDwell) { // during the hold the street is the next one: the tangent it starts with, or (a zero-length street) the next tower
          onChain(built[ti + 1], 0, tmp, wantS);
          if (wantS.lengthSq() < 1e-12) wantS.copy(cells[towers[ti + 1].cell].normal);
          wantS.addScaledVector(d, -wantS.dot(d));
          if (wantS.lengthSq() < 1e-12) wantS.copy(wantT); else wantS.normalize();
        } else wantS.copy(wantT);
        f = fin * (1 - (lastDwell ? 0 : smooth(clamp((S - (sg.s1 - tout[ti])) / tout[ti], 0, 1))));
      }
      if (i === 0) e.copy(wantS); else e.addScaledVector(d, -e.dot(d));
      if (e.lengthSq() < 1e-10) e.copy(wantS);
      e.normalize();
      side.crossVectors(d, e);
      let a = Math.atan2(wantS.dot(side), wantS.dot(e)), b = Math.atan2(wantT.dot(side), wantT.dot(e));
      if (i > 0) { a += Math.PI * 2 * Math.round((prevS - a) / (Math.PI * 2)); b += Math.PI * 2 * Math.round((prevT - b) / (Math.PI * 2)); } // unwrap: no 2 pi jumps
      prevS = a; prevT = b;
      psiS.push(a); psiT.push(b);
      headDir.push(d.clone()); headRef.push(e.clone()); headFocus.push(f); headStop.push(ti);
    }
    // the street heading is rounded (a street bends 60 degrees round a cell corner in a couple of route units: followed exactly the camera would whip); the turns to and from a tower are not
    const sS = gauss(psiS, walkCfg.streetSec * walkCfg.rate);
    let prev = 0;
    const raw: number[] = [];
    for (let i = 0; i <= HEAD_N; i++) {
      let psi = sS[i] + headFocus[i] * wrapPi(psiT[i] - sS[i]);
      if (i > 0) psi += Math.PI * 2 * Math.round((prev - psi) / (Math.PI * 2));
      prev = psi; raw.push(psi);
    }
    const lead = Math.max(1, walkCfg.streetSec * 2 * walkCfg.rate); // the route sets off from rest: the heading eases in over the first stretch instead of already turning at the first step
    const r0 = raw[0];
    for (let i = 0; i <= HEAD_N; i++) raw[i] = r0 + (raw[i] - r0) * smooth(clamp(((i / HEAD_N) * total) / lead, 0, 1));
    gauss(raw, HEADING_SIGMA * total).forEach((v, i) => (headPsi[i] = v));
    gauss(headFocus, walkCfg.zoomSec * walkCfg.rate).forEach((v, i) => (headZoom[i] = v)); // the zoom and the tip-up lead and trail the turn a little, and ease in and out on their own
  }
  const tabAt = (tab: number[], u: number) => {
    const x = clamp(u, 0, 1) * HEAD_N, i = Math.min(HEAD_N - 1, Math.floor(x));
    return tab[i] + (tab[i + 1] - tab[i]) * (x - i);
  };
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

  // ---- facing a tower: the angle the view tips to so the cap sits capY of the way up the frame, from the stand point at the middle of the hold ----
  // Blended in with the (blurred) facing weight rather than looked up per sample, so there is no switch of target where one tower's hold hands over to the next.
  const headAim: number[] = [];
  {
    const dv = new Vector3(), fw = new Vector3(), v = new Vector3();
    const holdFov = Math.min(walkCfg.fov, walkCfg.holdFov);
    const alpha = Math.atan(walkCfg.capY * Math.tan((holdFov * Math.PI) / 360));
    const pitch0 = (walkCfg.pitchDeg * Math.PI) / 180;
    const axis = towers.map((t, i) => {
      const dw = segs[2 * i + 1], um = (dw.s0 + (dw.s1 - dw.s0) / 2) / total;
      place(um, dv, fw);
      const tc = cells[t.cell];
      v.copy(tc.normal).multiplyScalar(R + tc.base + walkCfg.towerGrow).addScaledVector(dv, -(R + envAt(um) + walkCfg.eye));
      const elev = Math.asin(clamp(v.dot(dv) / Math.max(1e-6, v.length()), -1, 1));
      return clamp(elev - alpha, -pitch0, (walkCfg.capUpMax * Math.PI) / 180);
    });
    gauss(headFocus.map((f, i) => f * axis[headStop[i]]), walkCfg.zoomSec * walkCfg.rate).forEach((x, i) => (headAim[i] = x));
  }

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
      // facing a tower: zoom in and tip the view up (see headAim); never looking lower than the walking pitch
      const zw = tabAt(headZoom, u);
      const holdFov = Math.min(p.fov, walkCfg.holdFov);
      const pitch = ((p.pitchDeg * Math.PI) / 180) * (1 - zw) - tabAt(headAim, u);
      const fov = p.fov + (holdFov - p.fov) * zw;
      qPitch.setFromAxisAngle(right, -pitch);
      out.quaternion.copy(qPitch).multiply(qBase);
      out.fov = fov;
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
  const sw = clamp((w - 0.6) / 0.38, 0, 1); // (the camera is about one globe radius up at w = 0.6 and a few units up at 0.95)
  const s = sw * sw * sw * (sw * (sw * 6 - 15) + 10);
  if (upB && targetA) {
    // Not a blend of two orientations (a rotation blend passes through views that look away from the globe altogether, half way down; a slerp flips where the two are nearly opposite) but
    // one look-at whose view DIRECTION turns from "towards the spline's target, from where the camera now is" to the walker's heading (a normalised lerp, late in the descent: smootherstep over
    // its lower part) and whose roll reference moves from the world's up to the walker's own frame: the walker's heading while the view is steep (looking straight down the surface normal, which
    // the dive passes close to, any radial up is degenerate), the walker's up once it is level. At w = 0 it is the spline's own look-at and at w = 1 exactly the walker's orientation.
    _fA.copy(targetA).sub(outPos).normalize();
    _fB.set(0, 0, -1).applyQuaternion(quatB);
    _fS.copy(_fA).lerp(_fB, s);
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
        const m = clamp((w - 0.3) / 0.3, 0, 1), roll = d * (m * m * (3 - 2 * m));
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

const _lookM = new Matrix4(), _up = new Vector3(0, 1, 0);
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
  return blendWalkPose(splinePos, _qSpline, 40, walker.position, walker.quaternion, walker.fov, base, w, outPos, outQuat, splineTarget, walker.up);
}

/** Handheld sway state: the smoothed ground speed and the step phase. Fresh per world. */
export interface WalkSway { phase: number; speed: number; prev: Vector3; has: boolean }
export const createWalkSway = (): WalkSway => ({ phase: 0, speed: 0, prev: new Vector3(), has: false });

const _swRoll = new Quaternion(), _swZ = new Vector3(0, 0, 1), _swRight = new Vector3();
/**
 * The walker's bob, side shift and roll, on top of the finished camera (position `pos`, orientation `q`, both edited in place). Amplitude and cadence follow the
 * walker's ground speed (measured from `pos` frame to frame, smoothed), so it is zero when paused or holding at a tower, and `weight` fades it in with the dive and
 * out with the rise. `refSpeed` is the mean leg speed (route units per second): at that speed the walker takes `cfg.hz` steps a second.
 */
export function applyWalkSway(
  s: WalkSway, pos: Vector3, q: Quaternion, up: Vector3, forward: Vector3, dt: number, weight: number,
  cfg: { bob: number; side: number; rollDeg: number; hz: number }, refSpeed: number,
): void {
  const raw = s.has && dt > 1e-4 ? s.prev.distanceTo(pos) / dt : 0;
  s.prev.copy(pos); s.has = true;
  s.speed += (Math.min(raw, 4 * refSpeed) - s.speed) * (1 - Math.exp(-dt / 0.25));
  const k = clamp(s.speed / Math.max(1e-6, refSpeed), 0, 1.3);
  s.phase += Math.PI * 2 * cfg.hz * k * dt;
  const amp = weight * Math.min(1, k * 1.5); // (fully swaying a little below the mean leg speed, so the eased ends of a leg still move)
  if (amp < 1e-4) return;
  _swRight.crossVectors(forward, up).normalize();
  const lateral = Math.sin(s.phase * 0.5);
  pos.addScaledVector(up, amp * cfg.bob * Math.sin(s.phase)).addScaledVector(_swRight, amp * cfg.side * lateral);
  _swRoll.setFromAxisAngle(_swZ, amp * ((cfg.rollDeg * Math.PI) / 180) * lateral);
  q.multiply(_swRoll);
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
