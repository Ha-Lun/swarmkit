// Plain node asserts: `node test/city/timeline.test.ts` from site/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BILL_SHARE, HERO_SHARE, MIN_BEAT_SHARE, SCROLL_VH, buildTimeline } from '../../src/lib/city/timeline.ts';
import { BEAT_IDS } from '../../src/lib/city/types.ts';
import type { BeatId, StageState, Timeline } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const STEPS = 1000;

function noNaN(v: unknown, path = 'state'): void {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is not finite`);
  else if (Array.isArray(v)) v.forEach((x, i) => noNaN(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noNaN(x, `${path}.${k}`);
}

/** Checks every run must pass; returns the sampled states. */
function common(T: Timeline): StageState[] {
  assert.deepEqual(T.beats.map((b) => b.id), BEAT_IDS);
  assert.equal(T.beats[0].u0, 0);
  assert.ok(Math.abs(T.beats[T.beats.length - 1].u1 - 1) < 1e-9);
  for (let i = 1; i < T.beats.length; i++) {
    assert.ok(Math.abs(T.beats[i].u0 - T.beats[i - 1].u1) < 1e-9, 'beats tile [0, 1]');
    assert.ok(T.beats[i].t0 >= T.beats[i - 1].t0, 'beat times non-decreasing');
  }
  for (const b of T.beats) {
    assert.ok(b.u1 >= b.u0 && b.t1 >= b.t0);
    if (!b.present) assert.equal(b.u1, b.u0, `absent ${b.id} has no scroll length`);
  }
  const states: StageState[] = [];
  let prev: StageState | null = null;
  for (let i = 0; i <= STEPS; i++) {
    const s = T.stateAt(i / STEPS);
    noNaN(s);
    if (prev) {
      assert.ok(s.runTime >= prev.runTime - 1e-9, 'runTime monotonic');
      assert.ok(BEAT_IDS.indexOf(s.beat) >= BEAT_IDS.indexOf(prev.beat), 'beats in order');
      assert.ok(s.blueprint >= prev.blueprint && s.split >= prev.split && s.mergeAll >= prev.mergeAll - 1e-12 && s.bill >= prev.bill);
      s.workers.forEach((w, k) => {
        assert.ok(w.build >= prev!.workers[k].build - 1e-12, `${w.slug} build monotonic`);
        assert.ok(w.merge >= prev!.workers[k].merge - 1e-12, `${w.slug} merge monotonic`);
      });
      for (const key of Object.keys(s.counters) as (keyof StageState['counters'])[]) assert.ok(s.counters[key] >= prev.counters[key]);
    }
    for (const x of [s.blueprint, s.split, s.mergeAll, s.bill, s.beatProgress, s.activeScan.progress]) assert.ok(x >= 0 && x <= 1);
    states.push(s);
    prev = s;
  }
  // Pure: same input, same output.
  for (const u of [0, 0.123, 0.5, 0.777, 1]) assert.deepEqual(T.stateAt(u), T.stateAt(u));
  assert.deepEqual(T.stateAt(-1), T.stateAt(0));
  assert.deepEqual(T.stateAt(2), T.stateAt(1));
  noNaN(T.stateAt(Number.NaN));
  const s0 = T.stateAt(0);
  assert.equal(s0.beat, 'hero');
  assert.ok(s0.workers.every((w) => w.phase === 'waiting' && w.build === 0));
  assert.ok(s0.extras.every((w) => w.phase === 'waiting'));
  assert.equal(s0.blueprint, 0);
  assert.equal(T.stateAt(1).beat, 'bill');
  assert.equal(T.stateAt(1).bill, 1);
  return states;
}

// --- The real run.
const T = buildTimeline(run);
const states = common(T);
const beat = (id: BeatId) => T.beats.find((b) => b.id === id)!;
assert.ok(T.beats.every((b) => b.present), 'the real run opens every beat');
for (const b of T.beats) if (b.id !== 'hero' && b.id !== 'bill') assert.ok(b.u1 - b.u0 >= MIN_BEAT_SHARE - 1e-9, `${b.id} is not a flash`);
assert.ok(Math.abs(beat('hero').u1 - HERO_SHARE) < 1e-9 && Math.abs(1 - beat('bill').u0 - BILL_SHARE) < 1e-9);
assert.ok(SCROLL_VH > 0);
// Beats open on the recorded events.
assert.equal(beat('plan').t0, 2.5);
assert.equal(beat('lanes').t0, 20.6);
assert.equal(beat('verify').t0, 227.4);
assert.equal(beat('merge').t0, 534.9);
assert.equal(beat('review').t0, 542);
assert.equal(beat('bill').t0, 1387);
assert.equal(T.runTimeAt(1), run.wall_s);
assert.equal(T.runTimeAt(0), 0);

const end = T.stateAt(1);
assert.ok(end.workers.every((w) => w.phase === 'merged' && w.merge === 1 && w.build === 1), 'every worker merged at the end');
assert.ok(end.extras.every((x) => x.phase === 'merged' && x.merge === 1));
assert.equal(end.mergeAll, 1);
assert.equal(end.counters.merged, run.workers.length + end.extras.length);
assert.equal(end.counters.crossReviewsDone, run.events.filter((e) => e.by === 'cross-model').length);
assert.equal(end.counters.dispatched, run.events.filter((e) => e.type === 'dispatch').length);
assert.ok(end.workers.every((w) => w.scan === 'passed' && w.review === 'cross-model'));
assert.ok(end.drones.every((d) => d.jobs.length === 0), 'drones parked at the end');
assert.equal(end.planApproval, 'automatic');
assert.equal(end.planApproved, true);
const resumesByWorker = new Map(run.workers.map((w) => [w.slug, w.resumes]));
for (const w of end.workers) assert.equal(w.resumes, resumesByWorker.get(w.slug), `${w.slug} resumes`);

// Honest order: every original lot is fully merged before the first cross-model review starts.
const firstCross = states.findIndex((s) => s.activeScan.kind === 'cross-model-review');
assert.ok(firstCross > 0);
assert.ok(states[firstCross].workers.every((w) => w.phase === 'merged'), 'merges happen before the cross-model review');
assert.ok(states.slice(0, firstCross).every((s) => s.counters.crossReviewsDone === 0));
// Extras (the review-fixes annex) appear only after the review beat starts.
for (const s of states) {
  if (s.extras.some((x) => x.build > 0 || x.phase !== 'waiting')) assert.ok(s.u >= beat('review').u0, `extra visible at u=${s.u}`);
}
// cron: flagged by a failed verify, reworked by an agy fixer (cronfix) while its own lane is opencode, then passes.
const cronStates = states.map((s) => s.workers.find((w) => w.slug === 'cron')!);
assert.ok(cronStates.some((w) => w.scan === 'flagged' && w.flag === 'tests-failed'));
assert.ok(cronStates.some((w) => w.phase === 'reworking' && w.reworkLane === 'agy'));
assert.ok(states.some((s) => s.drones.find((d) => d.lane === 'agy')!.jobs.some((j) => j.slug === 'cron')));
// Every worker goes through building and merging.
for (const slug of run.workers.map((w) => w.slug)) {
  const phases = new Set(states.map((s) => s.workers.find((w) => w.slug === slug)!.phase));
  for (const p of ['waiting', 'building', 'built', 'merging', 'merged'] as const) assert.ok(phases.has(p), `${slug} reaches ${p}`);
}
// Blueprint draws during plan, split completes before the lanes beat.
assert.ok(states.filter((s) => s.beat === 'plan').some((s) => s.blueprint > 0 && s.blueprint < 1));
assert.equal(T.stateAt(beat('lanes').u0).split, 1);
assert.equal(T.stateAt(beat('plan').u0 - 1e-6).blueprint, 0);
// Scans: verify, orchestrator review and cross-model review all show.
const kinds = new Set(states.map((s) => s.activeScan.kind));
for (const k of ['verify', 'orchestrator-review', 'cross-model-review'] as const) assert.ok(kinds.has(k));

// --- Synthetic runs.
const base = { ...run, workers: [], events: [] } as unknown as FeaturedRun;
const minimal = buildTimeline({ ...base, events: [{ type: 'task', t: 0, order: 0 }, { type: 'done', t: 10, order: 1, ok: true }] } as FeaturedRun);
common(minimal);
assert.deepEqual(minimal.beats.filter((b) => b.present).map((b) => b.id), ['hero', 'task', 'bill']);
assert.equal(minimal.stateAt(1).workers.length, 0);
assert.equal(minimal.stateAt(1).mergeAll, 0);

const untimed = buildTimeline({
  ...run,
  events: run.events.map(({ t: _t, ...e }) => e),
} as FeaturedRun);
const untimedStates = common(untimed);
assert.ok(untimedStates[STEPS].workers.every((w) => w.phase === 'merged'));

const noPlanNoExtras = buildTimeline({
  ...run,
  plan_approval: undefined,
  events: run.events.filter((e) => e.type !== 'plan_mode' && e.type !== 'plan_approved' && !(e.extra && !e.base)),
} as FeaturedRun);
const npStates = common(noPlanNoExtras);
assert.equal(noPlanNoExtras.beats.find((b) => b.id === 'plan')!.present, false);
assert.equal(npStates[STEPS].extras.length, 0);
assert.equal(npStates[STEPS].blueprint, 1);
assert.equal(npStates[STEPS].planApproval, null);

common(buildTimeline({ ...base, events: [] } as unknown as FeaturedRun));
common(buildTimeline({ ...base, events: [{ type: 'done', t: 3, order: 0 }] } as FeaturedRun));
assert.throws(() => buildTimeline({} as FeaturedRun));
assert.throws(() => buildTimeline({ ...run, events: undefined } as unknown as FeaturedRun));

// Report the beat table for the real run.
for (const b of T.beats) console.log(`${b.id.padEnd(7)} u ${b.u0.toFixed(3)}-${b.u1.toFixed(3)}  t ${b.t0}-${b.t1} s`);
console.log('timeline.test.ts: ok');
