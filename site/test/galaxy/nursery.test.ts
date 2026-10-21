import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStory } from '../../src/lib/galaxy/story.ts';
import type { Story } from '../../src/lib/galaxy/story.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';
import { L } from '../../src/lib/galaxy/path.ts';
import type { V3 } from '../../src/lib/galaxy/path.ts';
import {
  buildNursery, cocoonK, flashPhase, igniteK, knotK, stagger, testPulseK, threadK, verifyFor, verifyU, VIEW_DIR,
} from '../../src/lib/galaxy/nursery.ts';

function loadReal(): FeaturedRun {
  const candidates = [
    resolve(process.cwd(), 'public/data/featured-run.json'),
    resolve(process.cwd(), 'site/public/data/featured-run.json'),
  ];
  for (const f of candidates) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as FeaturedRun;
    } catch {
      // try next
    }
  }
  throw new Error('featured-run.json not found from ' + process.cwd());
}

const run = loadReal();
const story = buildStory(run);
const N = story.workers.length;
const SHELL = 5.6;
const minSep = 0.9 * SHELL * Math.sqrt(4 / N) * 0.5;
const nur = buildNursery(story, 1.6);
const deg = (d: number): number => (d * Math.PI) / 180;
const len = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
const angleDeg = (a: V3, b: V3): number => (Math.acos((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b))) * 180) / Math.PI;

// deterministic: two calls agree exactly; N stars; close-up is the fixer worker.
assert.deepEqual(buildNursery(story, 1.6), nur, 'deterministic');
assert.equal(nur.stars.length, N);
assert.equal(nur.closeUp, 'cron');

// geometry: |pos| inside the shell +-8%, dir unit, every star inside the band around VIEW_DIR.
for (const aspect of [1.6, 0.46]) {
  const shell = SHELL * (aspect < 1 ? Math.max(0.72, aspect + 0.25) : 1);
  const got = buildNursery(story, aspect);
  for (const s of got.stars) {
    const r = len(s.pos);
    assert.ok(r >= shell * 0.92 - 1e-9 && r <= shell * 1.08 + 1e-9, `${s.slug} radius ${r} at ${aspect}`);
    assert.ok(Math.abs(len(s.dir) - 1) < 1e-9, `${s.slug} dir unit`);
    const a = angleDeg(s.dir, VIEW_DIR);
    assert.ok(a >= 55 - 1e-9 && a <= 125 + 1e-9, `${s.slug} band angle ${a} at ${aspect}`);
  }
  // no star sits straight in front of or behind Opus (hard bounds, not just the band average)
  for (const s of got.stars) {
    const front = dot(s.pos, VIEW_DIR) / len(s.pos);
    assert.ok(Math.abs(front) <= Math.cos(deg(55)) + 1e-9, `${s.slug} off-axis`);
  }
  // pairwise separation
  for (let i = 0; i < got.stars.length; i++) {
    for (let j = i + 1; j < got.stars.length; j++) {
      const d = len(got.stars[i].pos.map((v, k) => v - got.stars[j].pos[k]) as V3);
      assert.ok(d >= minSep - 1e-9, `separation ${got.stars[i].slug}/${got.stars[j].slug} ${d} < ${minSep} at ${aspect}`);
    }
  }
}

// rank = 0-based order by launchIndex; extent = farthest star.
assert.deepEqual(nur.stars.map((s) => s.rank), nur.stars.map((s) => s.launchIndex));
let far = 0;
for (const s of nur.stars) far = Math.max(far, len(s.pos));
assert.ok(Math.abs(nur.extent - far) < 1e-9, 'extent is the max |pos|');

// verify plans copied from system.ts: cron fixer with 3 red flashes, template + wrap resume with 1, five clean.
const bySlug = new Map(nur.stars.map((s) => [s.slug, s]));
const cron = bySlug.get('cron')!;
assert.equal(cron.verify.redFlashes, 3);
assert.equal(cron.verify.resolution, 'fixer');
assert.equal(cron.verify.fixer!.slug, 'cronfix');
for (const slug of ['template', 'wrap']) {
  const s = bySlug.get(slug)!;
  assert.equal(s.verify.redFlashes, 1, slug);
  assert.equal(s.verify.resolution, 'resume', slug);
  assert.equal(s.verify.fixer, null, slug);
}
const clean = nur.stars.filter((s) => s.verify.resolution === 'clean');
assert.equal(clean.length, 5);
for (const s of clean) assert.equal(s.verify.redFlashes, 0, s.slug);
// verifyFor itself agrees, and the re-exported plan helpers still behave.
const raw = story.workers.find((w) => w.slug === 'cron')!;
assert.deepEqual(verifyFor(raw), cron.verify);
assert.equal(Object.is(flashPhase, (await import('../../src/lib/galaxy/system.ts')).flashPhase), true, 'flashPhase re-exported');
assert.equal(Object.is(stagger, (await import('../../src/lib/galaxy/system.ts')).stagger), true, 'stagger re-exported');
assert.equal(flashPhase(cron.verify, 0).red, 0);
assert.equal(stagger(1, 3, 8, 0.5), 1);

// helpers monotonic on a 1/400 grid, 0 before their windows, 1 after.
const grid = 400;
const mono = (get: (t: number) => number, label: string): void => {
  let prev = -Infinity;
  for (let j = 0; j <= grid; j++) {
    const v = get(j / grid);
    assert.ok(v >= prev - 1e-12 && v >= 0 && v <= 1, `${label} monotonic at ${j / grid}`);
    prev = v;
  }
};
const n = N;
for (let i = 0; i < n; i++) {
  // knots glow in during the plan beat pp 0.56..0.75
  assert.equal(knotK(0.555, i, n), 0, `knotK before for ${i}`);
  assert.equal(knotK(0.76, i, n), 1, `knotK after for ${i}`);
  mono((t) => knotK(t, i, n), `knotK ${i}`);
  // thread over L.fan
  assert.equal(threadK(L.fan[0] - 0.01, i, n), 0, `threadK before for ${i}`);
  assert.equal(threadK(L.fan[1] + 0.01, i, n), 1, `threadK after for ${i}`);
  mono((t) => threadK(t, i, n), `threadK ${i}`);
  // ignition right after the thread lands
  mono((t) => igniteK(t, i, n), `igniteK ${i}`);
  assert.equal(igniteK(L.fan[0], i, n), 0, `igniteK before for ${i}`);
  assert.equal(igniteK(L.fan[1] + 0.041, i, n), 1, `igniteK after for ${i}`);
  for (let j = 0; j <= grid; j++) {
    if (threadK(j / grid, i, n) < 1) assert.equal(igniteK(j / grid, i, n), 0, `igniteK 0 while thread short (i=${i} j=${j})`);
  }
  mono((t) => verifyU(t, i, n), `verifyU ${i}`);
  mono((t) => testPulseK(t, i, n), `testPulseK ${i}`);
}

// build staggered by buildIndex, wrapper story order
for (let bi = 0; bi < n; bi++) {
  assert.equal(cocoonK(L.build[0] - 0.01, bi, n), 0, `cocoonK before for ${bi}`);
  assert.equal(cocoonK(L.build[1] + 0.01, bi, n), 1, `cocoonK after for ${bi}`);
  mono((t) => cocoonK(t, bi, n), `cocoonK ${bi}`);
}

// test pulses: inner ranks start and land first; all land by the end of L.scan
for (let r = 0; r < n - 1; r++) {
  const land = (rank: number): number => {
    let u = L.scan[0];
    while (testPulseK(u, rank, n) < 1) u += 1e-4;
    return u;
  };
  assert.ok(land(r) < land(r + 1), `pulse ${r} lands before ${r + 1}`);
}
for (let r = 0; r < n; r++) {
  assert.equal(testPulseK(L.scan[0], r, n), 0, `pulse starts at scan[0] for ${r}`);
  assert.equal(testPulseK(L.scan[1], r, n), 1, `pulse lands by scan[1] for ${r}`);
  assert.equal(verifyU(L.scan[0], r, n), 0, `verifyU 0 at scan[0] for ${r}`);
  assert.equal(verifyU(L.scan[1] + L.tick, r, n), 1, `verifyU done by scan[1]+tick for ${r}`);
}

// tiny stories: n=1 edge and no fixer -> no close-up.
const synth: Story = {
  task: 'synthetic',
  label: 'synthetic',
  workers: [
    { slug: 'a', lane: 'agy', launchIndex: 0, buildIndex: 0, failedVerifies: 0, resumes: 0, failed: false, fixer: null, reviewed: false, reviewedBy: null, mergeIndex: null },
    { slug: 'b', lane: 'agy', launchIndex: 1, buildIndex: 1, failedVerifies: 1, resumes: 0, failed: true, fixer: null, reviewed: false, reviewedBy: null, mergeIndex: null },
  ],
  lanes: ['agy'],
  counts: { workers: 2, dispatches: 2, reviews: 0, merges: 0, fixers: 0, crossModelReviews: 0, branchReviews: 0 },
  verifyOk: true,
};
const two = buildNursery(synth, 1.6);
assert.equal(two.closeUp, null);
assert.equal(two.stars.length, 2);
mono((t) => threadK(t, 0, 2), 'threadK n=2');
mono((t) => testPulseK(t, 0, 2), 'testPulseK n=2');
const one = buildNursery({ workers: [synth.workers[0]] }, 1.6);
assert.equal(one.stars.length, 1);
assert.equal(one.closeUp, null);
mono((t) => threadK(t, 0, 1), 'threadK n=1');
mono((t) => testPulseK(t, 0, 1), 'testPulseK n=1');
mono((t) => knotK(t, 0, 1), 'knotK n=1');
mono((t) => igniteK(t, 0, 1), 'igniteK n=1');
assert.equal(testPulseK(L.scan[1], 0, 1), 1, 'n=1 pulse lands by scan[1]');
assert.equal(verifyU(L.scan[1] + L.tick, 0, 1), 1, 'n=1 verify done');
assert.deepEqual(buildNursery({ workers: [] }, 1.6), { stars: [], closeUp: null, extent: 0 });

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
