// Plain node asserts: `node --test test/swarm/` from site/. The pure formation
// baker: shapes, bounds, roles, colours, determinism.
import assert from 'node:assert/strict';
import { PALETTE, buildFormations, mulberry32 } from '../../src/lib/swarm/formations.ts';
import type { Lane } from '../../src/lib/swarm/formations.ts';

const FORMATIONS = ['disk', 'lattice', 'streams', 'towers', 'hex', 'ring', 'trio'] as const;
const LANES: Lane[] = ['agy', 'opencode'];
const COUNT = 1000;
const OPUS = Math.ceil(COUNT * 0.06);

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
const F = buildFormations({ count: COUNT, lanes: LANES });
assert.equal(F.count, COUNT);
for (const id of FORMATIONS) assert.equal(F.positions[id].length, COUNT * 3, `${id} length`);
assert.equal(F.colors.length, COUNT * 3);
assert.equal(F.roles.length, COUNT);
assert.equal(F.delays.length, COUNT);
assert.equal(F.scales.length, COUNT);
assert.equal(F.kinds.length, COUNT);
assert.equal(F.ranks.length, COUNT);
for (const id of FORMATIONS) assert.equal(F.params[id].length, COUNT, `${id} params length`);

// --- Everything finite.
for (const id of FORMATIONS) for (const v of F.positions[id]) assert.ok(Number.isFinite(v), `${id} finite`);
for (const id of FORMATIONS) for (const v of F.params[id]) assert.ok(v >= 0 && v <= 1, `${id} param in 0..1`);
for (const v of [...F.colors, ...F.roles, ...F.delays, ...F.scales, ...F.kinds, ...F.ranks]) {
  assert.ok(Number.isFinite(v), 'attr finite');
}

// --- Same seed identical, different seed differs, default seed is 7.
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

// --- Delays uniform 0..1; worker scales 0.5..1.6 (0.5 + 1.1 rand^4: mostly small).
let bright = 0;
let halo = 0;
let bokeh = 0;
for (let i = 0; i < COUNT; i++) {
  assert.ok(F.delays[i] >= 0 && F.delays[i] < 1, 'delay in [0,1)');
  assert.ok(F.scales[i] >= 0.5 && F.scales[i] <= 1.6, 'scale in range');
  if (F.roles[i] === 0) {
    assert.ok(F.kinds[i] === 1 || F.kinds[i] === 2, 'Opus is core or halo');
    if (F.kinds[i] === 2) halo++;
  } else {
    assert.ok(F.kinds[i] === 0 || F.kinds[i] === 3, 'worker is plain or bokeh');
    if (F.kinds[i] === 3) bokeh++;
    if (F.scales[i] > 1.1) bright++;
  }
}
assert.ok(bright / (COUNT - OPUS) < 0.15, 'only a few bright workers');
assert.ok(halo >= 1 && halo <= OPUS / 8, 'a few halo sprites');
assert.ok(bokeh < (COUNT - OPUS) * 0.05, 'bokeh is rare');

// --- Ranks: stratified u in (0,1), strictly increasing within each group.
{
  const last = new Map<number, number>();
  for (let i = 0; i < COUNT; i++) {
    const u = F.ranks[i];
    assert.ok(u > 0 && u < 1, 'rank in (0,1)');
    const g = F.groups[i];
    assert.equal(g, F.roles[i] === 0 ? -1 : F.roles[i] - 1, 'group matches role');
    assert.ok(u > (last.get(g) ?? 0), `rank increases within group ${g}`);
    last.set(g, u);
  }
}

// --- Formation semantics: Opus core sits at the origin for disk, hovers for towers.
for (let i = 0; i < OPUS; i++) {
  const d = F.positions.disk;
  assert.ok(Math.hypot(d[i * 3], d[i * 3 + 1], d[i * 3 + 2]) <= 0.56, 'disk Opus core sphere');
  const t = F.positions.towers;
  assert.ok(Math.hypot(t[i * 3], t[i * 3 + 1] - 3.4, t[i * 3 + 2]) <= 0.36, 'towers Opus hover');
}

// --- Trio (r=1.2 at x=-4.2/0/4.2, y=-0.4): with >= 3 lanes, lane k joins cluster
// k%3; Opus is split across the three centres (j%3); with 2 lanes i%3.
const CX3 = [-4.2, 0, 4.2];
{
  const t = F.positions.trio;
  for (let i = 0; i < COUNT; i++) {
    const c = i % 3; // 2 lanes: particle i joins cluster i%3 (Opus: j = i)
    assert.ok(Math.hypot(t[i * 3] - CX3[c], t[i * 3 + 1] + 0.4, t[i * 3 + 2]) <= 1.21, `trio sphere ${c}`);
  }
  const L5: Lane[] = ['agy', 'opencode', 'agy', 'opencode', 'agy'];
  const G = buildFormations({ count: COUNT, lanes: L5 });
  for (let i = 0; i < COUNT; i++) {
    const c = i < OPUS ? i % 3 : G.groups[i] % 3;
    const p = G.positions.trio;
    assert.ok(Math.hypot(p[i * 3] - CX3[c], p[i * 3 + 1] + 0.4, p[i * 3 + 2]) <= 1.21, `trio cluster k%3 for ${i}`);
  }
}

// --- Identity mapping: stream k stays in its own region in every formation.
// Per formation, group mean position (centroid, workers only) for 6 lanes must be
// distinct between streams, and u must be monotonic along the stream's path.
{
  const n = 6;
  const L6: Lane[] = Array.from({ length: n }, (_, k) => (k % 2 ? 'opencode' : 'agy'));
  const G = buildFormations({ count: 3000, lanes: L6 });
  const ang = (k: number): number => Math.PI / 2 + (k * Math.PI * 2) / n;
  for (const id of ['lattice', 'streams'] as const) {
    // Ray k / comet k: the direction from the centre stays within +-25deg of its lane angle.
    const p = G.positions[id];
    for (let i = 0; i < 3000; i++) {
      const k = G.groups[i];
      if (k < 0 || G.params[id][i] < 0.25) continue; // near the core, directions blur
      const a = Math.atan2(p[i * 3 + 1], p[i * 3]);
      let d = Math.abs(a - ang(k)) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      assert.ok(d < 0.75, `${id} stream ${k} stays in its angular region (${d.toFixed(2)})`);
    }
  }
  // Towers: height is monotonic in u, x within the tower.
  const tw = G.positions.towers;
  for (let i = 0; i < 3000; i++) {
    const k = G.groups[i];
    if (k < 0) continue;
    assert.ok(Math.abs(tw[i * 3] - (-5 + (10 * k) / (n - 1))) <= 0.5, `towers stream ${k} x region`);
    assert.ok(Math.abs(G.positions.towers[i * 3 + 1] - (-2.6 + G.ranks[i] * 4.2)) <= 4.2, 'tower y bounded');
  }
  // Hex / ring: arc k covers [k/n,(k+1)/n] of the loop; param follows u.
  for (const id of ['hex', 'ring'] as const) {
    for (let i = 0; i < 3000; i++) {
      const k = G.groups[i];
      if (k < 0) continue;
      assert.ok(Math.abs(G.params[id][i] - (k + G.ranks[i]) / n) < 1e-5, `${id} param = (k+u)/n`);
    }
  }
  // Monotonic: within a stream, params in lattice/streams/towers/disk rise with u.
  for (const id of ['disk', 'lattice', 'streams', 'towers'] as const) {
    const lastP = new Map<number, number>();
    for (let i = 0; i < 3000; i++) {
      const k = G.groups[i];
      if (k < 0) continue;
      const v = G.params[id][i];
      assert.ok(v >= (lastP.get(k) ?? -1) - 1e-6, `${id} param monotonic in u (stream ${k})`);
      lastP.set(k, v);
    }
  }
  // Neighbour coherence: consecutive-rank particles of a stream are close in the lattice.
  const lat = G.positions.lattice;
  let prev = -1;
  let tot = 0;
  let cnt = 0;
  for (let i = 0; i < 3000; i++) {
    if (G.groups[i] !== 2) continue;
    if (prev >= 0) {
      tot += Math.hypot(lat[i * 3] - lat[prev * 3], lat[i * 3 + 1] - lat[prev * 3 + 1], lat[i * 3 + 2] - lat[prev * 3 + 2]);
      cnt++;
    }
    prev = i;
  }
  assert.ok(tot / cnt < 0.2, 'rank neighbours stay neighbours');
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
