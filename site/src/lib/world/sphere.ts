// Procedural Goldberg sphere GP(f,0): an icosahedron subdivided f times per edge, then dualised. Every vertex of
// the subdivided mesh becomes one cell: 10 f^2 + 2 cells, exactly 12 of them pentagons (the icosahedron corners),
// the rest hexagons. Pure numbers, no three.js, so it runs at build time (Node) and in the browser.
//
// Orientation is fixed by the layout, not by the caller: the core cell (a 2-fold edge-midpoint hex, flanked by two
// pentagons) sits on +Z, and the sphere is rolled so those two pentagons lie left and right of it.

export type Vec3 = [number, number, number];

export interface SphereCell {
  /** unit-sphere centre */
  center: Vec3;
  /** indices of the cells sharing an edge */
  neighbours: number[];
  /** unit-sphere polygon corners (spherical Voronoi vertices), counter-clockwise seen from outside */
  corners: Vec3[];
  sides: 5 | 6;
}

export interface Sphere {
  freq: number;
  cells: SphereCell[];
  /** index of the core cell (+Z) */
  core: number;
  /** mean centre-to-centre chord on the unit sphere */
  meanSpacing: number;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => mul(a, 1 / (len(a) || 1));

function icosahedron(): { v: Vec3[]; f: [number, number, number][] } {
  const y = 1 / Math.sqrt(5), r = 2 / Math.sqrt(5);
  const ring = (lat: number, off: number) => Array.from({ length: 5 }, (_, k): Vec3 => {
    const a = off + (k * 2 * Math.PI) / 5;
    return [r * Math.sin(a), lat, r * Math.cos(a)];
  });
  const v: Vec3[] = [[0, 1, 0], [0, -1, 0], ...ring(y, 0), ...ring(-y, Math.PI / 5)];
  const U = (k: number) => 2 + (k % 5), L = (k: number) => 7 + (k % 5);
  const f: [number, number, number][] = [];
  for (let k = 0; k < 5; k++) {
    f.push([0, U(k), U(k + 1)], [U(k), L(k), U(k + 1)], [L(k), L(k + 1), U(k + 1)], [1, L(k + 1), L(k)]);
  }
  return { v, f };
}

const cache = new Map<number, Sphere>();

export function buildSphere(freq = 4): Sphere {
  const hit = cache.get(freq);
  if (hit) return hit;
  const ico = icosahedron();

  // subdivide each face on a barycentric grid; merge shared vertices by rounded position
  const verts: Vec3[] = [];
  const index = new Map<string, number>();
  const at = (p: Vec3) => {
    const q = norm(p);
    const key = q.map((c) => Math.round(c * 1e4)).join(',');
    let i = index.get(key);
    if (i === undefined) { i = verts.length; verts.push(q); index.set(key, i); }
    return i;
  };
  const tris: [number, number, number][] = [];
  for (const [ia, ib, ic] of ico.f) {
    const [A, B, C] = [ico.v[ia], ico.v[ib], ico.v[ic]];
    const g: number[][] = [];
    for (let i = 0; i <= freq; i++) {
      g.push([]);
      for (let j = 0; j <= freq - i; j++) {
        g[i].push(at(add(add(mul(A, freq - i - j), mul(B, i)), mul(C, j))));
      }
    }
    for (let i = 0; i < freq; i++) {
      for (let j = 0; j < freq - i; j++) {
        tris.push([g[i][j], g[i + 1][j], g[i][j + 1]]);
        if (j < freq - i - 1) tris.push([g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]]);
      }
    }
  }

  const nbr: Set<number>[] = verts.map(() => new Set());
  const around: number[][] = verts.map(() => []); // triangle indices around each vertex
  tris.forEach((t, ti) => t.forEach((a, k) => {
    around[a].push(ti);
    nbr[a].add(t[(k + 1) % 3]); nbr[a].add(t[(k + 2) % 3]);
  }));

  // Relaxation: a plain projected subdivision leaves cells of visibly different size. Springs pull every edge
  // towards the mean edge length (the 12 corners stay on their axes by symmetry), which evens the spacing out.
  const edges: [number, number][] = [];
  nbr.forEach((s, i) => s.forEach((j) => { if (j > i) edges.push([i, j]); }));
  for (let it = 0; it < 300; it++) {
    let mean = 0;
    edges.forEach(([i, j]) => (mean += len(sub(verts[i], verts[j]))));
    mean /= edges.length;
    const push = verts.map((): Vec3 => [0, 0, 0]);
    edges.forEach(([i, j]) => {
      const d = sub(verts[j], verts[i]);
      const l = len(d) || 1;
      const f = mul(d, ((l - mean) / l) * 0.25);
      push[i] = add(push[i], f);
      push[j] = sub(push[j], f);
    });
    verts.forEach((p, i) => (verts[i] = norm(add(p, push[i]))));
  }

  // core: the vertex on the midpoint of an icosahedron edge (a 2-fold hex with a pentagon at each end of the edge)
  const mid = norm(add(ico.v[0], ico.v[2]));
  let core = 0;
  verts.forEach((p, i) => { if (dot(p, mid) > dot(verts[core], mid)) core = i; });

  // rotate core -> +Z (minimal rotation), then roll about Z so the two flanking pentagons sit left and right
  const z: Vec3 = [0, 0, 1];
  const rot = (p: Vec3, axis: Vec3, ang: number): Vec3 => {
    const c = Math.cos(ang), s = Math.sin(ang);
    return add(add(mul(p, c), mul(cross(axis, p), s)), mul(axis, dot(axis, p) * (1 - c)));
  };
  const ax = cross(verts[core], z);
  const aligned = len(ax) < 1e-9 ? verts.slice() : verts.map((p) => rot(p, norm(ax), Math.acos(Math.min(1, dot(verts[core], z)))));
  const corner = ico.v.map((p) => {
    let b = 0;
    verts.forEach((q, i) => { if (dot(q, p) > dot(verts[b], p)) b = i; });
    return b;
  });
  const flank = corner.reduce((best, i) => (dot(aligned[i], z) > dot(aligned[best], z) ? i : best), corner[0]);
  const roll = Math.PI / 2 - Math.atan2(aligned[flank][1], aligned[flank][0]); // flank pentagon -> +X
  const V = aligned.map((p) => rot(p, z, roll));

  const cells: SphereCell[] = V.map((c, i) => {
    const e1 = norm(cross(c, Math.abs(c[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const e2 = cross(c, e1);
    // spherical Voronoi vertex of each triangle around the cell (its circumcentre on the sphere): every cell edge then lies
    // exactly on the bisector with its neighbour, so a constant inset gives a constant seam width
    const centroids = around[i].map((ti) => {
      const t = tris[ti];
      const a = V[t[0]], b = V[t[1]], d = V[t[2]];
      const n = norm(cross(sub(b, a), sub(d, a)));
      return dot(n, add(add(a, b), d)) < 0 ? mul(n, -1) : n;
    });
    const ang = (p: Vec3) => Math.atan2(dot(p, e2), dot(p, e1));
    centroids.sort((a, b) => ang(a) - ang(b));
    return { center: c, neighbours: [...nbr[i]], corners: centroids, sides: nbr[i].size === 5 ? 5 : 6 };
  });

  let sum = 0, n = 0;
  cells.forEach((c, i) => c.neighbours.forEach((j) => { if (j > i) { sum += len(sub(c.center, cells[j].center)); n++; } }));
  const sphere: Sphere = { freq, cells, core, meanSpacing: sum / n };
  cache.set(freq, sphere);
  return sphere;
}
