import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStory } from '../../src/lib/galaxy/story.ts';
import type { FeaturedRun, RunEvent, RunWorker } from '../../src/lib/run.ts';

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

// Passthrough fields derive straight from the run.
assert.equal(story.task, run.task);
assert.equal(story.label, run.label);
assert.equal(story.verifyOk, run.verify_ok);

// 8 workers in launch (first-dispatch) order. Cross-checked against the JSON's
// own dispatch order, not just a hardcoded list.
const dispatchOrder = run.events
  .filter((e) => e.type === 'dispatch' && e.extra !== true)
  .sort((a, b) => a.order - b.order)
  .map((e) => e.slug);
assert.deepEqual(dispatchOrder, ['expr', 'cron', 'semver', 'diff', 'csv', 'lru', 'template', 'wrap']);
assert.deepEqual(
  story.workers.map((w) => w.slug),
  dispatchOrder,
);
assert.deepEqual(
  story.workers.map((w) => w.launchIndex),
  [0, 1, 2, 3, 4, 5, 6, 7],
);
assert.deepEqual(
  story.workers.map((w) => w.buildIndex),
  [0, 1, 2, 3, 4, 5, 6, 7],
);

// Lanes: distinct worker lanes in first-launch order.
assert.deepEqual(story.lanes, ['opencode', 'agy']);

// cron: the fixer case — 3 failed verifies, fixed via cronfix on lane agy.
const cron = story.workers.find((w) => w.slug === 'cron');
assert.ok(cron);
assert.equal(cron.failedVerifies, 3);
assert.equal(cron.failed, true);
assert.deepEqual(cron.fixer, { slug: 'cronfix', lane: 'agy' });

// NOTE: the brief said "exactly one failed worker", but the JSON's verify
// events show three slugs with ok === false: cron x3 (orders 20, 41, 44) plus
// template x1 (order 25) and wrap x1 (order 26). The JSON wins: failed must be
// derived from verify events, so template and wrap are failed too.
const failedBySlug = new Map(story.workers.map((w) => [w.slug, w.failedVerifies]));
assert.deepEqual(Object.fromEntries(failedBySlug), {
  expr: 0,
  cron: 3,
  semver: 0,
  diff: 0,
  csv: 0,
  lru: 0,
  template: 1,
  wrap: 1,
});
assert.deepEqual(
  story.workers.filter((w) => w.failed).map((w) => w.slug),
  ['cron', 'template', 'wrap'],
);
for (const w of story.workers) {
  if (w.slug === 'cronfix' || w.slug === 'review-fixes') continue;
  assert.equal(w.failed, (w.failedVerifies as number) > 0, w.slug);
}

// Every worker's work landed: each has a non-null mergeIndex. cron's points at
// the cronfix merge; everyone else's at their own merge.
const mergeOrder = run.events
  .filter((e) => e.type === 'merge')
  .sort((a, b) => a.order - b.order)
  .map((e) => e.slug);
for (const w of story.workers) {
  assert.ok(w.mergeIndex !== null && w.mergeIndex >= 0, `${w.slug} merged`);
  const target = w.fixer !== null ? w.fixer.slug : w.slug;
  assert.equal(mergeOrder[w.mergeIndex as number], target, w.slug);
}

// Counts match the event counts (extras count as dispatches/fixers, not workers).
const count = (t: string) => run.events.filter((e) => e.type === t).length;
assert.deepEqual(story.counts, {
  workers: run.workers.length,
  dispatches: count('dispatch'),
  reviews: count('review'),
  merges: count('merge'),
  fixers: run.events.filter((e) => e.type === 'dispatch' && e.extra === true).length,
});
assert.equal(story.counts.workers, 8);
assert.equal(story.counts.dispatches, 10); // 8 workers + cronfix + review-fixes
assert.equal(story.counts.reviews, 8); // 5 slugged + 3 cross-model
assert.equal(story.counts.merges, 9); // 7 own + cronfix + review-fixes
assert.equal(story.counts.fixers, 2); // cronfix + review-fixes

// RunWorker.ok === false is a denied command, NOT failure: workers with ok
// false but zero failed verifies are NOT failed.
for (const slug of ['expr', 'semver', 'diff', 'csv', 'lru']) {
  const rw = run.workers.find((w) => w.slug === slug);
  const sw = story.workers.find((w) => w.slug === slug);
  assert.ok(rw && sw);
  assert.equal(rw.ok, false, `${slug} RunWorker.ok`);
  assert.equal(sw.failedVerifies, 0, `${slug} failedVerifies`);
  assert.equal(sw.failed, false, `${slug} failed`);
}

// Reviews: the five slugged reviews are orchestrator; cron/template/wrap have
// no slugged review (the cross-model reviews carry no slug, so attach to none).
for (const slug of ['expr', 'semver', 'diff', 'csv', 'lru']) {
  const sw = story.workers.find((w) => w.slug === slug);
  assert.ok(sw);
  assert.equal(sw.reviewed, true, slug);
  assert.equal(sw.reviewedBy, 'orchestrator', slug);
}
for (const slug of ['cron', 'template', 'wrap']) {
  const sw = story.workers.find((w) => w.slug === slug);
  assert.ok(sw);
  assert.equal(sw.reviewed, false, slug);
  assert.equal(sw.reviewedBy, null, slug);
}
assert.equal(story.workers.filter((w) => w.fixer !== null).length, 1);

// Deterministic: same run gives the same story.
assert.deepEqual(buildStory(run), story);

// ---- Synthetic runs ----

let order = 0;
function ev(partial: Omit<RunEvent, 'order'> & { order?: number }): RunEvent {
  return { order: order++, ...partial } as RunEvent;
}
function mkWorker(partial: Partial<RunWorker> & { slug: string; lane: 'agy' | 'opencode' }): RunWorker {
  return {
    ok: true,
    tokens: 0,
    denied_count: 0,
    files: [],
    lanes_tried: [partial.lane],
    resumes: 0,
    merged: false,
    ...partial,
  };
}
function mkRun(partial: Partial<FeaturedRun> & { workers: RunWorker[]; events: RunEvent[] }): FeaturedRun {
  return {
    label: 'synthetic',
    task: 'synthetic task',
    case: 'synthetic',
    variant: 'synthetic',
    model: null,
    cost_usd: 0,
    wall_s: 0,
    duration_s: 0,
    turns: 0,
    verify_ok: true,
    worker_tokens: {},
    lanes: ['agy'],
    attempt: 1,
    attempts: 1,
    earlier_attempts: [],
    ...partial,
  };
}

// Synthetic 1: no reviews anywhere, one never-merged worker with no worker_done.
order = 0;
const synthNoReviews = mkRun({
  verify_ok: false,
  workers: [
    mkWorker({ slug: 'alpha', lane: 'agy', merged: true }),
    mkWorker({ slug: 'beta', lane: 'agy', merged: false }),
  ],
  events: [
    ev({ type: 'dispatch', slug: 'alpha', lane: 'agy' }),
    ev({ type: 'dispatch', slug: 'beta', lane: 'agy' }),
    ev({ type: 'worker_done', slug: 'alpha', lane: 'agy', ok: true }),
    ev({ type: 'verify', slug: 'alpha', ok: true }),
    ev({ type: 'merge', slug: 'alpha', lane: 'agy' }),
  ],
});
const s1 = buildStory(synthNoReviews);
assert.equal(s1.workers.length, 2);
assert.deepEqual(s1.workers.map((w) => w.slug), ['alpha', 'beta']);
const [alpha, beta] = s1.workers;
assert.equal(alpha.reviewed, false);
assert.equal(alpha.reviewedBy, null);
assert.equal(alpha.mergeIndex, 0);
assert.equal(alpha.buildIndex, 0);
assert.equal(alpha.failed, false);
assert.equal(beta.reviewed, false);
assert.equal(beta.reviewedBy, null);
assert.equal(beta.mergeIndex, null, 'never-merged worker');
assert.equal(beta.failed, false);
assert.equal(beta.failedVerifies, 0);
// beta has no worker_done, so it sorts last for build order even though it launched second here;
// with only alpha done, beta is buildIndex 1.
assert.equal(beta.buildIndex, 1);
assert.deepEqual(s1.counts, { workers: 2, dispatches: 2, reviews: 0, merges: 1, fixers: 0 });
assert.deepEqual(s1.lanes, ['agy']);

// Synthetic 2: cross-model review wins, fixer merge lands the work, failed verifies fail the worker.
order = 0;
const synthFixer = mkRun({
  workers: [mkWorker({ slug: 'gamma', lane: 'opencode', ok: false, merged: true, merged_via: 'gammafix' })],
  events: [
    ev({ type: 'dispatch', slug: 'gamma', lane: 'opencode' }),
    ev({ type: 'worker_done', slug: 'gamma', lane: 'opencode', ok: false }),
    ev({ type: 'verify', slug: 'gamma', ok: false }),
    ev({ type: 'verify', slug: 'gamma', ok: false }),
    ev({ type: 'review', slug: 'gamma', lane: 'opencode', by: 'orchestrator' }),
    ev({ type: 'review', slug: 'gamma', lane: 'opencode', by: 'cross-model' }),
    ev({ type: 'dispatch', slug: 'gammafix', lane: 'agy', extra: true, base: 'gamma' }),
    ev({ type: 'worker_done', slug: 'gammafix', lane: 'agy', ok: true, extra: true }),
    ev({ type: 'verify', slug: 'gamma', ok: true }),
    ev({ type: 'merge', slug: 'gammafix', lane: 'agy', extra: true }),
  ],
});
const s2 = buildStory(synthFixer);
assert.equal(s2.workers.length, 1, 'extra branches are not workers');
const [gamma] = s2.workers;
assert.equal(gamma.launchIndex, 0);
assert.equal(gamma.buildIndex, 0);
assert.equal(gamma.failedVerifies, 2);
assert.equal(gamma.failed, true);
assert.deepEqual(gamma.fixer, { slug: 'gammafix', lane: 'agy' });
assert.equal(gamma.reviewed, true);
assert.equal(gamma.reviewedBy, 'cross-model');
assert.equal(gamma.mergeIndex, 0, 'fixer merge lands the work');
assert.deepEqual(s2.counts, { workers: 1, dispatches: 2, reviews: 2, merges: 1, fixers: 1 });
assert.deepEqual(s2.lanes, ['opencode']);

// Synthetic 3: merged_via with no matching dispatch -> fixer null; merge missing -> null mergeIndex.
order = 0;
const synthOrphan = mkRun({
  workers: [mkWorker({ slug: 'solo', lane: 'agy', merged: false, merged_via: 'ghost' })],
  events: [ev({ type: 'dispatch', slug: 'solo', lane: 'agy' })],
});
const s3 = buildStory(synthOrphan);
assert.equal(s3.workers[0].fixer, null);
assert.equal(s3.workers[0].mergeIndex, null);
assert.equal(s3.workers[0].buildIndex, 0, 'no worker_done at all still gets a stable index');
assert.equal(s3.workers[0].reviewedBy, null);
