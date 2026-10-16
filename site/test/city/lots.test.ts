// Plain node asserts: `node test/city/lots.test.ts` from site/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout, lotPoseAt } from '../../src/lib/city/lots.ts';
import type { Rect } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const EPS = 1e-9;

const overlaps = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - EPS;
const inside = (a: Rect, outer: Rect) =>
  a.x - a.w / 2 >= outer.x - outer.w / 2 - EPS && a.x + a.w / 2 <= outer.x + outer.w / 2 + EPS
  && a.z - a.d / 2 >= outer.z - outer.d / 2 - EPS && a.z + a.d / 2 <= outer.z + outer.d / 2 + EPS;
const noPairOverlap = (rs: Rect[], what: string) => {
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) assert.ok(!overlaps(rs[i], rs[j]), `${what} ${i} and ${j} overlap`);
};

const L = buildLayout(run);
const originals = L.lots.filter((l) => !l.extra);
const extras = L.lots.filter((l) => l.extra);

// 8 original lots, one per worker; the extras are the annex lots (review-fixes), not the stacked fixer (cronfix).
assert.equal(originals.length, run.workers.length);
assert.deepEqual(new Set(originals.map((l) => l.slug)), new Set(run.workers.map((w) => w.slug)));
assert.deepEqual(extras.map((l) => l.slug), ['review-fixes']);
assert.ok(!L.lots.some((l) => l.slug === 'cronfix'), 'a fixer stacked on a worker is rework, not a lot');
assert.equal(new Set(L.lots.map((l) => l.slug)).size, L.lots.length, 'slugs unique');

// Geometry invariants.
for (const l of originals) assert.ok(inside(l, L.plot), `${l.slug} inside the plot`);
noPairOverlap(originals, 'plot lot');
assert.equal(L.block.length, L.lots.length);
L.block.forEach((s, i) => {
  assert.equal(s.slug, L.lots[i].slug);
  assert.equal(s.w, L.lots[i].w);
  assert.equal(s.d, L.lots[i].d);
});
const workerSlots = L.block.slice(0, originals.length);
noPairOverlap(workerSlots, 'block slot');
for (const s of workerSlots) assert.ok(inside(s, L.cityBlock), `${s.slug} slot inside the city block`);
assert.ok(!overlaps(L.cityBlock, L.plot), 'block and plot apart');
assert.ok(L.cityBlock.x < L.plot.x, 'city block on the -x side');
assert.equal(L.annex.length, extras.length);
for (const [j, a] of L.annex.entries()) {
  const lot = extras[j];
  assert.equal(a.slug, lot.slug);
  assert.ok(a.x === lot.x && a.z === lot.z, 'extra is built in its annex slot');
  assert.ok(!overlaps(a, L.plot), 'annex outside the plot');
  assert.ok(!overlaps(a, L.cityBlock), 'annex outside the block');
}
noPairOverlap(L.lots, 'lot');
for (const d of L.depots) assert.ok(!inside({ x: d.x, z: d.z, w: 0, d: 0 }, L.plot), `${d.lane} depot outside the plot`);
assert.deepEqual(L.depots.map((d) => d.lane), ['agy', 'opencode']);
assert.ok(L.depots.every((d) => d.used), 'this run used both lanes');
assert.ok(L.depots[0].z * L.depots[1].z < 0, 'depots on opposite sides');
for (const r of [L.plot, L.cityBlock, ...L.lots]) assert.ok(inside(r, L.bounds), 'bounds cover everything');
for (const seg of L.roads) for (const v of [seg.x1, seg.z1, seg.x2, seg.z2, seg.width]) assert.ok(Number.isFinite(v));
assert.ok(L.roads.length > 0);

// Lots near square.
for (const l of L.lots) assert.ok(Math.max(l.w / l.d, l.d / l.w) <= 1.5);

// Heights: monotonic in tokens, cron (tokens 0) flagged unknown with a stand-in height.
const known = originals.filter((l) => l.tokensKnown);
const tokens = new Map(run.workers.map((w) => [w.slug, w.tokens]));
const byTokens = [...known].sort((a, b) => tokens.get(a.slug)! - tokens.get(b.slug)!);
for (let i = 1; i < byTokens.length; i++) assert.ok(byTokens[i].height >= byTokens[i - 1].height, 'height monotonic in tokens');
const cron = originals.find((l) => l.slug === 'cron')!;
assert.equal(cron.tokensKnown, false);
assert.ok(cron.height > Math.min(...known.map((l) => l.height)) && cron.height < Math.max(...known.map((l) => l.height)));
assert.ok(extras.every((l) => !l.tokensKnown));
for (const l of L.lots) assert.ok(l.height > 0 && Number.isFinite(l.height));

// Deterministic.
assert.deepEqual(buildLayout(run), L);
assert.deepEqual(buildLayout(JSON.parse(JSON.stringify(run))), L);

// Degenerate runs.
const minimal = { ...run, workers: [], events: [{ type: 'task', t: 0, order: 0 }, { type: 'done', t: 1, order: 1 }] } as FeaturedRun;
const M = buildLayout(minimal);
assert.equal(M.lots.length, 0);
assert.equal(M.block.length, 0);
assert.ok(Number.isFinite(M.bounds.w));
const manyExtras = {
  ...minimal,
  events: [0, 1, 2].map((i) => ({ type: 'dispatch', slug: `x${i}`, lane: 'agy', extra: true, t: i, order: i })),
} as FeaturedRun;
const X = buildLayout(manyExtras);
assert.equal(X.annex.length, 3);
noPairOverlap(X.lots, 'extra-only lot');
for (const l of X.lots) assert.ok(!overlaps(l, X.plot));
for (let n = 1; n <= 13; n++) {
  const workers = Array.from({ length: n }, (_, i) => ({ ...run.workers[i % run.workers.length], slug: `w${i}`, tokens: 1000 * (i + 1) }));
  const G = buildLayout({ ...run, workers } as FeaturedRun);
  const lots = G.lots.filter((l) => !l.extra);
  assert.equal(lots.length, n);
  noPairOverlap(G.lots, `n=${n} lot`);
  noPairOverlap(G.block, `n=${n} slot`);
  for (const l of lots) assert.ok(inside(l, G.plot));
  for (const a of G.annex) assert.ok(!overlaps(a, G.plot) && !overlaps(a, G.cityBlock));
}
assert.throws(() => buildLayout({} as FeaturedRun));

// lotPoseAt: lot at 0, slot at 1, grounded at both ends, reuses `out`.
const out = { x: 0, y: 0, z: 0 };
L.lots.forEach((lot, i) => {
  assert.equal(lotPoseAt(L, i, 0, out), out);
  assert.ok(out.x === lot.x && out.z === lot.z && out.y === 0);
  lotPoseAt(L, i, 1, out);
  assert.ok(Math.abs(out.x - L.block[i].x) < 1e-9 && Math.abs(out.z - L.block[i].z) < 1e-9 && Math.abs(out.y) < 1e-9);
});

console.log('lots.test.ts: ok');
