// Plain node asserts: `node --test test/swarm/` from site/. The pure formation
// baker: shapes, bounds, roles, colours, determinism.
import assert from 'node:assert/strict';
import { PALETTE, buildFormations, mulberry32 } from '../../src/lib/swarm/formations.ts';
import type { Lane } from '../../src/lib/swarm/formations.ts';

const FORMATIONS = ['disk', 'lattice', 'streams', 'towers', 'hex', 'ring', 'trio'] as const;
const LANES: Lane[] = ['agy', 'opencode'];
const COUNT = 1000;
const OPUS = Math.ceil(COUNT * 0.08);

const approx = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// --- mulberry32: deterministic, in [0, 1).
const r1 = mulberry32(7);
const r2 = mulberry32(7);
for (let i = 0; i < 50; i++) {
  const v = r1();
  assert.equal(v, r2());
  assert.ok(v >= 0 && v < 1, 'rng in range');
}

// --- Array shapes.
assert.equal(F.count, COUNT);
for (const id of FORMATIONS) assert.equal(F.positions[id].length, COUNT * 3, `${id} length`);
assert.equal(F.colors.length, COUNT * 3);
assert.equal(F.roles.length, COUNT);
assert.equal(F.delays.length, COUNT);
assert.equal(F.scales.length, COUNT);

// --- Everything finite.
for (const id of FORMATIONS) for (const v of F.positions[id]) assert.ok(Number.isFinite(v), `${id} finite`);
for (const v of [...F.colors, ...F.roles, ...F.delays, ...F.scales]) assert.ok(Number.isFinite(v), 'attr finite');

// --- Same seed identical, different seed differs, default seed is 7.
const F = buildFormations({ count: COUNT, lanes: LANES });
const again = buildFormations({ count: COUNT, lanes: LANES, seed: 7 });
assert.deepEqual(again, F);
const other = buildFormations({ count: COUNT, lanes: LANES, seed: 8 });
for (const id of FORMATIONS) {
  assert.equal(other.positions[id].length, F.positions[id].length);
  assert.ok(
    other.positions[id].some((v, i) => v !== F.positions[id][i]),
    `${id} differs under a different seed`,
  );
}
assert.ok(other.delays.some((v, i) => v !== F.delays[i]), 'delays differ under a different seed');

// --- Bounds: |x|<=7 |y|<=4.5 |z|<=4 for every formation.
for (const id of FORMATIONS) {
  const p = F.positions[id];
  for (let i = 0; i < COUNT; i++) {
    assert.ok(Math.abs(p[i * 3]) <= 7, `${id}[${i}].x in frame`);
    assert.ok(Math.abs(p[i * 3 + 1]) <= 4.5, `${id}[${i}].y in frame`);
    assert.ok(Math.abs(p[i * 3 + 2]) <= 4, `${id}[${i}].z in frame`);
  }
}

// --- Roles: first ceil(8%) Opus core, rest round-robin over lanes.
let opus = 0;
const perStream = [0, 0];
for (let i = 0; i < COUNT; i++) {
  assert.ok(Number.isInteger(F.roles[i]) && F.roles[i] >= 0 && F.roles[i] <= LANES.length, 'role in range');
  if (i < OPUS) {
    assert.equal(F.roles[i], 0, 'first 8% are Opus');
    opus++;
  } else {
    assert.equal(F.roles[i], (i % LANES.length) + 1, 'round-robin streams');
    perStream[i % LANES.length]++;
  }
}
assert.equal(opus, OPUS);
assert.ok(Math.abs(perStream[0] - perStream[1]) <= 1, 'streams split evenly');

// --- Colours match PALETTE by role.
for (let i = 0; i < COUNT; i++) {
  const lane = F.roles[i] === 0 ? null : LANES[F.roles[i] - 1];
  const c = F.roles[i] === 0 ? PALETTE.opus : PALETTE[lane!];
  assert.ok(
    approx(F.colors[i * 3], c[0]) && approx(F.colors[i * 3 + 1], c[1]) && approx(F.colors[i * 3 + 2], c[2]),
    `particle ${i} colour matches role ${F.roles[i]}`,
  );
}

// --- Delays uniform 0..1; scales 0.5..1.6 with a bright Opus core.
let bright = 0;
for (let i = 0; i < COUNT; i++) {
  assert.ok(F.delays[i] >= 0 && F.delays[i] < 1, 'delay in [0,1)');
  assert.ok(F.scales[i] >= 0.5 && F.scales[i] <= 1.6, 'scale in range');
  if (F.roles[i] === 0) assert.ok(F.scales[i] >= 1.4 && F.scales[i] <= 1.6, 'Opus scales bright');
  else if (F.scales[i] > 1.1) bright++;
}
assert.ok(bright / (COUNT - OPUS) < 0.15, 'only a few bright workers');

// --- Formation semantics: Opus core sits at the origin for disk, hovers for towers.
for (let i = 0; i < OPUS; i++) {
  const d = F.positions.disk;
  assert.ok(Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) <= 0.56, 'disk Opus core sphere');
  const t = F.positions.towers;
  assert.ok(Math.hypot(t[i * 3], t[i * 3 + 1] - 3.4, t[i * 3 + 2]) <= 0.36, 'towers Opus hover');
}

// --- Trio: particle i sits in sphere i%3 (r=1.2 at x=-4.2/0/4.2, y=-0.4).
const CX3 = [-4.2, 0, 4.2];
{
  const t = F.positions.trio;
  for (let i = 0; i < COUNT; i++) {
    assert.ok(Math.hypot(t[i * 3] - CX3[i % 3], t[i * 3 + 1] + 0.4, t[i * 3 + 2]) <= 1.21, `trio sphere ${i % 3}`);
  }
}

// --- Towers: N distinct x clusters for N lanes (try N=8 and N=3).
for (const n of [8, 3]) {
  const lanesN: Lane[] = Array.from({ length: n }, (_, k) => (k % 2 === 0 ? 'agy' : 'opencode'));
  const T = buildFormations({ count: 800, lanes: lanesN, seed: 5 });
  const centers = Array.from({ length: n }, (_, s) => (n === 1 ? 0 : -5 + (10 * s) / (n - 1)));
  const hits = new Array(n).fill(0);
  for (let s = 1; s < n; s++) assert.ok(centers[s] - centers[s - 1] > 1, 'clusters distinct');
  for (let i = 0; i < 800; i++) {
    if (T.roles[i] === 0) continue; // Opus hovers above the middle, not in a tower
    const s = i % n;
    assert.ok(Math.abs(T.positions.towers[i * 3] - centers[s]) <= 0.5, `tower stream ${s} clusters at x=${centers[s]}`);
    hits[s]++;
  }
  for (let s = 0; s < n; s++) assert.ok(hits[s] > 20, `tower ${s} populated`);
}

console.log('formations.test.ts: ok');
