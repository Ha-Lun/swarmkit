// Deterministic terrain for the globe and the moon: 3D value-noise fBm sampled on each cell's unit normal, with a ridged top octave
// so the relief reads as ranges and crags rather than round bumps. Pure data (no textures, no assets): the honeycomb turns the
// result into a per-cell column height. Same seed and scale always give the same globe.

const fract = (x: number) => x - Math.floor(x);

function hash3(x: number, y: number, z: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return fract(h);
}

/** smooth trilinear value noise in [0, 1] */
function vnoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const c = (a: number, b: number, d: number) => hash3(ix + a, iy + b, iz + d, seed);
  const l = (p: number, q: number, t: number) => p + (q - p) * t;
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), ux), l(c(0, 1, 0), c(1, 1, 0), ux), uy),
    l(l(c(0, 0, 1), c(1, 0, 1), ux), l(c(0, 1, 1), c(1, 1, 1), ux), uy),
    uz,
  );
}

/** raw terrain at a unit direction: three fBm octaves plus a ridged fourth. Roughly 0.1..0.9, not normalised. */
export function terrainRaw(x: number, y: number, z: number, scale: number, seed: number): number {
  const s = scale;
  const f1 = vnoise3(x * s, y * s, z * s, seed);
  const f2 = vnoise3(x * s * 2.03 + 5.2, y * s * 2.03 + 1.3, z * s * 2.03 + 9.1, seed);
  const f3 = vnoise3(x * s * 4.11 + 2.7, y * s * 4.11 + 8.4, z * s * 4.11 + 3.3, seed);
  const r = 1 - Math.abs(2 * vnoise3(x * s * 8.3 + 7.7, y * s * 8.3 + 4.1, z * s * 8.3 + 6.6, seed) - 1); // ridged top octave
  return 0.5 * f1 + 0.24 * f2 + 0.12 * f3 + 0.14 * r * r;
}

/** 0..1 per input direction, stretched to the full range over the given set (so `elevation` is exactly the tallest column). */
export function terrainField(dirs: { x: number; y: number; z: number }[], scale: number, seed: number): number[] {
  const raw = dirs.map((d) => terrainRaw(d.x, d.y, d.z, scale, seed));
  let lo = Infinity, hi = -Infinity;
  for (const v of raw) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(1e-6, hi - lo);
  return raw.map((v) => Math.pow((v - lo) / span, 1.25)); // a touch of contrast: mostly lowland, a few high ranges
}
