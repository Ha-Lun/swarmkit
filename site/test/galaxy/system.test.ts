import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStory } from '../../src/lib/galaxy/story.ts';
import type { Story } from '../../src/lib/galaxy/story.ts';
import { buildSystem, flashPhase, launchPos, planetPos, spiralIn, stagger, tilt } from '../../src/lib/galaxy/system.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

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
const sys = buildSystem(story, 1.6);
const bySlug = new Map(sys.planets.map((p) => [p.slug, p]));

// 8 planets; radii strictly increasing in launchIndex order; 1.6 -> 6.0.
assert.equal(sys.planets.length, 8);
assert.deepEqual(
  sys.planets.map((p) => p.launchIndex),
  [0, 1, 2, 3, 4, 5, 6, 7],
);
for (let i = 1; i < sys.planets.length; i++) {
  assert.ok(sys.planets[i].orbit > sys.planets[i - 1].orbit, `orbit ${i} increasing`);
}
assert.ok(Math.abs(sys.planets[0].orbit - 1.6) < 1e-9, 'first orbit 1.6');
assert.ok(Math.abs(sys.planets[7].orbit - 6.0) < 1e-9, 'last orbit 6.0');

// Portrait shrinks every orbit.
const narrow = buildSystem(story, 0.46);
assert.equal(narrow.planets.length, 8);
for (let i = 0; i < sys.planets.length; i++) {
  assert.ok(narrow.planets[i].orbit < sys.planets[i].orbit, `orbit ${i} smaller at 0.46`);
}

// closeUp is the worker with a fixer (cron in this run), never hardcoded.
assert.equal(sys.closeUp, 'cron');
assert.equal(sys.closeUp, story.workers.find((w) => w.fixer)!.slug);

// cron: fixer case; template + wrap: resumed; the other five are clean.
const cron = bySlug.get('cron')!;
assert.equal(cron.verify.redFlashes, 3);
assert.equal(cron.verify.resolution, 'fixer');
assert.equal(cron.verify.fixer!.slug, 'cronfix');
for (const slug of ['template', 'wrap']) {
  const p = bySlug.get(slug)!;
  assert.equal(p.verify.redFlashes, 1, slug);
  assert.equal(p.verify.resolution, 'resume', slug);
  assert.equal(p.verify.fixer, null, slug);
}
const clean = sys.planets.filter((p) => p.verify.resolution === 'clean');
assert.equal(clean.length, 5);
for (const p of clean) assert.equal(p.verify.redFlashes, 0, p.slug);

// planetPos: deterministic, on the tilted orbit.
for (const p of sys.planets) {
  for (const t of [0, 1.7, 42]) {
    assert.deepEqual(planetPos(p, t), planetPos(p, t), `${p.slug} deterministic`);
    const [x, y, z] = planetPos(p, t);
    assert.ok(Math.abs(y) <= p.orbit * Math.sin((3 * Math.PI) / 180) + 1e-9, `${p.slug} within 3 deg`);
    assert.ok(Math.abs(Math.hypot(x, y, z) - p.orbit) < 1e-9, `${p.slug} on orbit`);
  }
}

// incl in 0.5..3 deg, nodes deterministic, orbits not coplanar.
for (const p of sys.planets) {
  const deg = (Math.abs(p.incl) * 180) / Math.PI;
  assert.ok(deg >= 0.5 - 1e-9 && deg <= 3 + 1e-9, `${p.slug} incl ${deg} deg`);
}
assert.ok(sys.planets.some((p) => planetPos(p, 1.7)[1] !== 0), 'not coplanar');
{
  const again = buildSystem(story, 1.6);
  for (let i = 0; i < sys.planets.length; i++) {
    assert.equal(again.planets[i].incl, sys.planets[i].incl, `incl deterministic ${i}`);
    assert.equal(again.planets[i].node, sys.planets[i].node, `node deterministic ${i}`);
  }
}

// tilt: rotation about the line of nodes preserves length and fixes the node line.
for (const p of sys.planets) {
  const n: [number, number, number] = [Math.cos(p.node), 0, Math.sin(p.node)];
  assert.deepEqual(tilt(p, n).map((v) => +v.toFixed(9)), n.map((v) => +v.toFixed(9)), `${p.slug} node line fixed`);
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648) * 2 - 1;
  };
  for (let j = 0; j < 20; j++) {
    const v: [number, number, number] = [rand() * 6, rand() * 6, rand() * 6];
    const w = tilt(p, v);
    assert.ok(Math.abs(Math.hypot(...w) - Math.hypot(...v)) < 1e-9, `${p.slug} preserves length`);
  }
}

// launchPos: sun at k=0, orbit at k=1.
for (const p of sys.planets) {
  assert.deepEqual(launchPos(p, 0, 2.3), [0, 0, 0], `${p.slug} launches from the sun`);
  assert.deepEqual(launchPos(p, 1, 2.3), planetPos(p, 2.3), `${p.slug} lands on orbit`);
}

// spiralIn: orbit at k=0, core at k=1, monotonic fall inward.
for (const p of sys.planets) {
  assert.deepEqual(spiralIn(p, 0, 2.3), planetPos(p, 2.3), `${p.slug} starts on orbit`);
  assert.deepEqual(spiralIn(p, 1, 2.3), [0, 0, 0], `${p.slug} ends at the core`);
  let prev = Infinity;
  for (let s = 0; s <= 10; s++) {
    const k = s / 10;
    const [x, , z] = spiralIn(p, k, 2.3);
    const d = Math.hypot(x, z);
    assert.ok(d <= prev, `${p.slug} non-increasing at k=${k}`);
    prev = d;
  }
}

// flashPhase: red 0 at both ends, green 1 at u=1, for every resolution.
for (const p of sys.planets) {
  assert.equal(flashPhase(p.verify, 0).red, 0, `${p.slug} red at 0`);
  assert.equal(flashPhase(p.verify, 1).red, 0, `${p.slug} red at 1`);
  assert.equal(flashPhase(p.verify, 1).green, 1, `${p.slug} green at 1`);
}
// cron holds exactly 3 red pulses sampled at 1/400 steps.
{
  const reds: number[] = [];
  for (let j = 0; j <= 400; j++) reds.push(flashPhase(cron.verify, j / 400).red);
  let peaks = 0;
  for (let j = 1; j < 400; j++) {
    if (reds[j] > reds[j - 1] && reds[j] >= reds[j + 1]) peaks++;
  }
  assert.equal(peaks, 3);
}

// stagger: nothing started at u=0 (except the first), all done at u=1, monotonic.
for (let i = 0; i < 8; i++) {
  if (i > 0) assert.equal(stagger(0, i, 8), 0, `stagger starts at 0 for ${i}`);
  assert.equal(stagger(1, i, 8), 1, `stagger ends at 1 for ${i}`);
  let prev = -Infinity;
  for (let s = 0; s <= 20; s++) {
    const v = stagger(s / 20, i, 8);
    assert.ok(v >= prev && v >= 0 && v <= 1, `stagger monotonic for ${i}`);
    prev = v;
  }
}

// Synthetic story: two workers, no fixer -> no close-up.
const synth: Story = {
  task: 'synthetic',
  label: 'synthetic',
  workers: [
    { slug: 'a', lane: 'agy', launchIndex: 0, buildIndex: 0, failedVerifies: 0, resumes: 0, failed: false, fixer: null, reviewed: false, reviewedBy: null, mergeIndex: 0 },
    { slug: 'b', lane: 'agy', launchIndex: 1, buildIndex: 1, failedVerifies: 1, resumes: 1, failed: true, fixer: null, reviewed: false, reviewedBy: null, mergeIndex: 0 },
  ],
  lanes: ['agy'],
  counts: { workers: 2, dispatches: 2, reviews: 0, merges: 1, fixers: 0, crossModelReviews: 0, branchReviews: 0 },
  verifyOk: true,
};
const synthSys = buildSystem(synth, 1.6);
assert.equal(synthSys.planets.length, 2);
assert.equal(synthSys.closeUp, null);
assert.equal(synthSys.planets[1].verify.resolution, 'resume');
