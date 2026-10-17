// Pure layout of the run's lots, the merged city block, the annex for extras, the lane depots and the roads.
// Deterministic: the same run always gives the same layout, and nothing here is random. See LotLayout in types.ts
// for the invariants; test/city/lots.test.ts checks them.
import type { FeaturedRun, RunEvent } from '../run.ts';
import { LANES } from './types.ts';
import type { Depot, ExistingBuilding, Lane, Lot, LotLayout, Rect, RoadSegment, Slot } from './types.ts';

/** Lot footprint (m) on the plot and in the block. */
export const LOT_SIZE = 3.6;
/** Gap between lots on the plot (m): the blueprint margin. */
export const LOT_GAP = 0.8;
/** Street width in the merged block (m). */
export const ROAD_W = 1.2;
/** Building height range (m) for the clamped log scale of tokens. */
export const H_MIN = 1.5;
export const H_MAX = 8.0;
/** Annex lots are smaller and low: they are a short pass after review. */
export const ANNEX_SIZE = LOT_SIZE * 0.6;
export const ANNEX_H = H_MIN * 0.8;
/** Depot distance from the plot edge (m). */
export const DEPOT_OFFSET = 4;
/** Clear space between the plot and the city block (m): a road runs down its middle. */
const PLOT_TO_BLOCK = 3;
/** Existing-city ring around the slot grid: columns of old town on -x, rows on each z side. */
const CITY_RING_X = 2;
const CITY_RING_Z = 1;
/** Existing-city parcels: outer setback range inside a cell, gap between buildings sharing a cell (m). */
const OLD_SETBACK = 0.2;
const OLD_GAP = 0.35;
/** Existing-city heights (m): low at the edge, taller towards the old core; a few towers. */
const OLD_H_EDGE = 0.9;
const OLD_H_CORE = 3.4;
const OLD_H_MAX = 6.0;

/** Seeded integer hash -> [0, 1). Deterministic stand-in for randomness (the existing city is decoration). */
function hash01(a: number, b: number, c: number): number {
  let h = Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * The code that existed before the run, as buildings: every grid cell of the city that is not a slot gets one, two
 * or four buildings with setbacks. Decorative, not data: seeded from the cell, never random.
 */
function existingCity(left: number, top: number, cols: number, rows: number, slotCols: number, n: number): ExistingBuilding[] {
  const pitch = LOT_SIZE + ROAD_W;
  const isSlot = (c: number, r: number) => {
    const sc = c - CITY_RING_X, sr = r - CITY_RING_Z;
    return sc >= 0 && sc < slotCols && sr >= 0 && sr * slotCols + sc < n;
  };
  const coreC = (CITY_RING_X - 1) / 2, coreR = (rows - 1) / 2;
  const reach = Math.hypot(cols, rows) / 2;
  const out: ExistingBuilding[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isSlot(c, r)) continue;
      const rnd = (k: number) => hash01(c, r, k);
      const cx = left + ROAD_W + pitch * c + LOT_SIZE / 2;
      const cz = top + ROAD_W + pitch * r + LOT_SIZE / 2;
      const inner = LOT_SIZE - 2 * (OLD_SETBACK + 0.25 * rnd(0));
      const x0 = cx - inner / 2, z0 = cz - inner / 2;
      // Split the parcel: one building, two (along x or z) or four.
      const kind = rnd(1);
      const split = kind < 0.3 ? 0 : kind < 0.65 ? (rnd(4) < 0.5 ? 1 : 2) : 3; // bit 1: along x, bit 2: along z
      const fx = 0.4 + 0.2 * rnd(2), fz = 0.4 + 0.2 * rnd(3);
      const xs: [number, number][] = split & 1 ? [[0, fx], [fx, 1]] : [[0, 1]];
      const zs: [number, number][] = split & 2 ? [[0, fz], [fz, 1]] : [[0, 1]];
      const closeness = Math.max(0, 1 - Math.hypot(c - coreC, r - coreR) / reach);
      let k = 10;
      for (const [ax, bx] of xs) {
        for (const [az, bz] of zs) {
          k += 4;
          const gx0 = ax > 0 ? OLD_GAP / 2 : 0, gx1 = bx < 1 ? OLD_GAP / 2 : 0;
          const gz0 = az > 0 ? OLD_GAP / 2 : 0, gz1 = bz < 1 ? OLD_GAP / 2 : 0;
          // Extra per-building setback on each side for a ragged street line.
          const sx = 0.18 * rnd(k), sz = 0.18 * rnd(k + 1);
          const bx0 = x0 + inner * ax + gx0 + sx, bx1 = x0 + inner * bx - gx1 - sx;
          const bz0 = z0 + inner * az + gz0 + sz, bz1 = z0 + inner * bz - gz1 - sz;
          let h = (OLD_H_EDGE + (OLD_H_CORE - OLD_H_EDGE) * closeness) * (0.6 + 0.8 * rnd(k + 2));
          if (rnd(k + 3) < 0.07) h *= 1.7; // the odd tower
          out.push({
            x: (bx0 + bx1) / 2, z: (bz0 + bz1) / 2, w: bx1 - bx0, d: bz1 - bz0,
            height: Math.min(OLD_H_MAX, Math.max(0.6, h)),
          });
        }
      }
    }
  }
  return out;
}

/** Grid for n cells: fewest empty cells, then closest to square; cols >= rows. */
function grid(n: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 1, rows: 1 };
  let best = { cols: n, rows: 1 };
  let bestScore = Infinity;
  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if (cols < rows) break;
    const score = cols * rows - n + 0.5 * (cols / rows - 1);
    if (score < bestScore) {
      bestScore = score;
      best = { cols, rows };
    }
  }
  return best;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Extras that get an annex lot: extra dispatches/merges with no base worker, in first-seen order. */
export function annexExtras(run: Pick<FeaturedRun, 'events' | 'workers'>): { slug: string; lane: Lane }[] {
  const workerSlugs = new Set(run.workers.map((w) => w.slug));
  const based = new Set(run.workers.map((w) => w.merged_via).filter((s): s is string => !!s));
  for (const e of run.events) if (e.extra && e.base && e.slug) based.add(e.slug);
  const out: { slug: string; lane: Lane }[] = [];
  const seen = new Set<string>();
  const events = [...run.events].sort((a: RunEvent, b: RunEvent) => a.order - b.order);
  for (const e of events) {
    if (!e.extra || !e.slug || seen.has(e.slug) || based.has(e.slug) || workerSlugs.has(e.slug)) continue;
    seen.add(e.slug);
    out.push({ slug: e.slug, lane: e.lane ?? 'agy' });
  }
  return out;
}

export function buildLayout(run: FeaturedRun): LotLayout {
  if (!Array.isArray(run?.workers) || !Array.isArray(run?.events)) throw new Error('buildLayout: malformed run');

  // Plot order: lanes in depot order (LANES[0] rows sit nearest its -z depot), then the run's worker order.
  const workers = run.workers
    .map((w, i) => ({ w, i }))
    .sort((a, b) => LANES.indexOf(a.w.lane) - LANES.indexOf(b.w.lane) || a.i - b.i)
    .map(({ w }) => w);
  const n = workers.length;
  const { cols, rows } = grid(n);
  const cell = LOT_SIZE + LOT_GAP;
  const plot: Rect = { x: 0, z: 0, w: cols * cell, d: rows * cell };

  // Height: clamped log scale between the smallest and largest known token counts. Unknown (0) -> median.
  const known = workers.map((w) => w.tokens).filter((t) => Number.isFinite(t) && t > 0);
  const lo = known.length ? Math.log(Math.min(...known)) : 0;
  const hi = known.length ? Math.log(Math.max(...known)) : 0;
  const heightOf = (tokens: number) => {
    if (!known.length) return (H_MIN + H_MAX) / 2;
    if (hi === lo) return (H_MIN + H_MAX) / 2;
    const f = Math.min(1, Math.max(0, (Math.log(tokens) - lo) / (hi - lo)));
    return H_MIN + f * (H_MAX - H_MIN);
  };
  const fallbackTokens = known.length ? median(known) : 0;

  const lots: Lot[] = workers.map((w, k) => {
    const r = Math.floor(k / cols);
    const inRow = r === rows - 1 ? n - r * cols : cols; // last row centred
    const c = k - r * cols;
    const rowW = inRow * cell;
    const tokensKnown = Number.isFinite(w.tokens) && w.tokens > 0;
    return {
      slug: w.slug,
      lane: w.lane,
      extra: false,
      x: -rowW / 2 + cell * (c + 0.5),
      z: -plot.d / 2 + cell * (r + 0.5),
      w: LOT_SIZE,
      d: LOT_SIZE,
      height: heightOf(tokensKnown ? w.tokens : fallbackTokens),
      tokensKnown,
    };
  });

  // City block: the existing city wrapped around a compact grid of empty slots (with streets) on its +x edge, the
  // side facing the plot. The ring adds CITY_RING_X columns of old town on -x and CITY_RING_Z rows on -z and +z.
  const bg = grid(n);
  const pitch = LOT_SIZE + ROAD_W;
  const fullCols = bg.cols + CITY_RING_X;
  const fullRows = bg.rows + 2 * CITY_RING_Z;
  const blockW = n ? fullCols * pitch + ROAD_W : 0;
  const blockD = n ? fullRows * pitch + ROAD_W : 0;
  const cityBlock: Rect = { x: -plot.w / 2 - PLOT_TO_BLOCK - blockW / 2, z: 0, w: blockW, d: blockD };
  const left = cityBlock.x - blockW / 2;
  const top = cityBlock.z - blockD / 2;
  // The slot sub-grid (its streets are the ones the merge draws in).
  const subLeft = left + CITY_RING_X * pitch;
  const subTop = top + CITY_RING_Z * pitch;
  const subW = n ? bg.cols * pitch + ROAD_W : 0;
  const subD = n ? bg.rows * pitch + ROAD_W : 0;
  const block: Slot[] = lots.map((lot, k) => ({
    slug: lot.slug,
    x: subLeft + ROAD_W + pitch * (k % bg.cols) + LOT_SIZE / 2,
    z: subTop + ROAD_W + pitch * Math.floor(k / bg.cols) + LOT_SIZE / 2,
    w: LOT_SIZE,
    d: LOT_SIZE,
  }));
  const existing = n ? existingCity(left, top, fullCols, fullRows, bg.cols, n) : [];

  // Annex: a row of small slots past the block's +z edge (or at the block position when there is no block).
  const extras = annexExtras(run);
  const annexPitch = ANNEX_SIZE + ROAD_W;
  const annexZ = (n ? cityBlock.z + blockD / 2 : 0) + ROAD_W + ANNEX_SIZE / 2;
  const annexLeft = n ? subLeft + ROAD_W : -plot.w / 2 - PLOT_TO_BLOCK - extras.length * annexPitch;
  // With a block, the annex sits under the slot columns and wraps at their width so it never reaches the plot;
  // without one it runs to -x.
  const annexCols = n ? Math.max(1, Math.floor((subW - ROAD_W) / annexPitch)) : Math.max(1, extras.length);
  const annex: Slot[] = extras.map((e, j) => ({
    slug: e.slug,
    x: annexLeft + annexPitch * (j % annexCols) + ANNEX_SIZE / 2,
    z: (n ? annexZ : 0) + annexPitch * Math.floor(j / annexCols),
    w: ANNEX_SIZE,
    d: ANNEX_SIZE,
  }));
  for (const [j, e] of extras.entries()) {
    const s = annex[j];
    lots.push({ slug: e.slug, lane: e.lane, extra: true, x: s.x, z: s.z, w: s.w, d: s.d, height: ANNEX_H, tokensKnown: false });
    block.push({ ...s });
  }

  // Depots: LANES[0] off the -z edge facing +z, LANES[1] off the +z edge facing -z.
  const usedLanes = new Set<Lane>([...(run.lanes ?? []), ...run.workers.map((w) => w.lane)]);
  for (const e of run.events) if (e.lane && (e.type === 'dispatch' || e.type === 'resume')) usedLanes.add(e.lane);
  const depots: Depot[] = LANES.map((lane, i) => {
    const sign = i === 0 ? -1 : 1;
    return { lane, x: 0, z: sign * (plot.d / 2 + DEPOT_OFFSET), facing: sign < 0 ? 0 : Math.PI, used: usedLanes.has(lane) };
  });

  // Roads: block perimeter and streets along the gaps between slots, the link road to the plot, the annex street.
  const roads: RoadSegment[] = [];
  if (n) {
    for (let r = 0; r <= bg.rows; r++) {
      const z = subTop + ROAD_W / 2 + r * pitch;
      roads.push({ x1: subLeft, z1: z, x2: subLeft + subW, z2: z, width: ROAD_W });
    }
    for (let c = 0; c <= bg.cols; c++) {
      const x = subLeft + ROAD_W / 2 + c * pitch;
      roads.push({ x1: x, z1: subTop, x2: x, z2: subTop + subD, width: ROAD_W });
    }
    const linkX = -plot.w / 2 - PLOT_TO_BLOCK / 2;
    roads.push({ x1: subLeft + subW, z1: 0, x2: linkX, z2: 0, width: ROAD_W });
    roads.push({ x1: linkX, z1: -plot.d / 2, x2: linkX, z2: plot.d / 2, width: ROAD_W });
  }
  if (annex.length) {
    // One street on the block side of each annex row.
    const rowsZ = [...new Set(annex.map((s) => s.z))];
    const x2 = annexLeft + annexPitch * Math.min(annexCols, annex.length) - ROAD_W / 2;
    for (const az of rowsZ) {
      const z = az - ANNEX_SIZE / 2 - ROAD_W / 2;
      roads.push({ x1: annexLeft - ROAD_W / 2, z1: z, x2, z2: z, width: ROAD_W });
    }
  }

  // Bounds over everything placed.
  const rects: Rect[] = [plot, ...annex, ...depots.map((d) => ({ x: d.x, z: d.z, w: cell, d: cell }))];
  if (n) rects.push(cityBlock);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x - r.w / 2);
    x1 = Math.max(x1, r.x + r.w / 2);
    z0 = Math.min(z0, r.z - r.d / 2);
    z1 = Math.max(z1, r.z + r.d / 2);
  }
  const bounds: Rect = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };

  return { plot, cell, lots, block, annex, cityBlock, existing, depots, roads, bounds };
}

/** Peak lift (m) of a lot while it slides into its block slot. */
export const MERGE_LIFT = 1.5;

/**
 * Where lot i stands at merge progress m (0..1): slides from lots[i] to block[i] on an arc that peaks at
 * MERGE_LIFT. Writes into `out` and returns it, so per-frame callers allocate nothing. Shared by the buildings
 * and merge parts so they never drift apart. Extras have lot == slot, so they only lift.
 */
export function lotPoseAt(layout: LotLayout, i: number, m: number, out: { x: number; y: number; z: number }) {
  const lot = layout.lots[i];
  const slot = layout.block[i] ?? lot;
  const t = m <= 0 ? 0 : m >= 1 ? 1 : m;
  out.x = lot.x + (slot.x - lot.x) * t;
  out.z = lot.z + (slot.z - lot.z) * t;
  out.y = lot.extra ? 0 : Math.sin(Math.PI * t) * MERGE_LIFT;
  return out;
}
