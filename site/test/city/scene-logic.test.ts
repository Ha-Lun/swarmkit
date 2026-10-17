// Plain node asserts: `node test/city/scene-logic.test.ts` from site/. Pure helpers of the scene: the camera
// keyframe builder and path (continuous and finite over a 1000-step sweep), the monotone u -> t map, smoothDamp,
// and the beat pose used by static frames.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beatCaptions, replayLabel } from '../../src/lib/city/captions.ts';
import { beatPoseU, buildCameraKeys, createCameraPath, monotoneCubic, smoothDamp } from '../../src/lib/city/camera.ts';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const layout = buildLayout(run);
const { beats } = buildTimeline(run);

for (const aspect of [16 / 9, 1440 / 810, 390 / 844, 1]) {
  const keys = buildCameraKeys(layout, beats, aspect);
  // One key per present beat, strictly increasing u from 0 to 1, all finite, camera above the ground.
  assert.equal(keys[0].u, 0);
  assert.equal(keys[keys.length - 1].u, 1);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i].u > keys[i - 1].u, 'keys strictly increasing in u');
  for (const k of keys) {
    for (const v of [...k.pos, ...k.target]) assert.ok(Number.isFinite(v), `${k.beat} key finite`);
    assert.ok(k.pos[1] > k.target[1], `${k.beat}: camera above its target`);
  }
  assert.deepEqual(keys.map((k) => k.beat), beats.filter((b) => b.present).map((b) => b.id));

  // 1000-step sweep: finite, above ground, and continuous (no step much larger than the typical one).
  const path = createCameraPath(keys);
  const p = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
  const steps: number[] = [];
  const tSteps: number[] = [];
  let prev: number[] | null = null;
  for (let i = 0; i <= 1000; i++) {
    path.poseAt(i / 1000, p, t);
    for (const v of [p.x, p.y, p.z, t.x, t.y, t.z]) assert.ok(Number.isFinite(v), `pose finite at ${i}`);
    assert.ok(p.y > 0.5, `camera above the ground at ${i}`);
    if (prev) {
      steps.push(Math.hypot(p.x - prev[0], p.y - prev[1], p.z - prev[2]));
      tSteps.push(Math.hypot(t.x - prev[3], t.y - prev[4], t.z - prev[5]));
    }
    prev = [p.x, p.y, p.z, t.x, t.y, t.z];
  }
  const span = Math.hypot(layout.bounds.w, layout.bounds.d);
  const maxStep = Math.max(...steps);
  assert.ok(maxStep < span * 0.05, `no jump in camera position (max step ${maxStep.toFixed(3)} m)`);
  assert.ok(Math.max(...tSteps) < span * 0.05, 'no jump in look-at target');
  // Speed continuity: neighbouring steps never differ by more than a small fraction of the largest step.
  for (let i = 1; i < steps.length; i++) {
    assert.ok(Math.abs(steps[i] - steps[i - 1]) < maxStep * 0.1 + 1e-6, `camera speed jumps at step ${i}`);
  }
  // The path hits every key.
  for (const k of keys) {
    path.poseAt(k.u, p, t);
    assert.ok(Math.hypot(p.x - k.pos[0], p.y - k.pos[1], p.z - k.pos[2]) < 1e-6, `${k.beat} pose reached`);
  }
}

// Monotone cubic: hits the knots, stays monotone, never overshoots.
{
  const f = monotoneCubic([0, 0.1, 0.5, 0.52, 1], [0, 0.25, 0.5, 0.75, 1]);
  let last = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    const y = f(i / 1000);
    assert.ok(y >= last - 1e-12 && y >= 0 && y <= 1, 'monotone within range');
    last = y;
  }
  assert.ok(Math.abs(f(0.5) - 0.5) < 1e-12);
}

// smoothDamp converges to the target without overshoot, and dt = 0 is a no-op.
{
  const s = { v: 0 };
  let x = 0;
  for (let i = 0; i < 120; i++) {
    x = smoothDamp(x, 1, s, 0.15, 1 / 60);
    assert.ok(x <= 1 + 1e-12, 'no overshoot');
  }
  assert.ok(Math.abs(x - 1) < 1e-3, 'settles within two seconds');
  assert.equal(smoothDamp(0.3, 1, { v: 0 }, 0.15, 0), 0.3);
}

// beatPoseU: hero snaps to 0, every other beat to a point inside its own range.
for (const b of beats.filter((bt) => bt.present && bt.u1 > bt.u0)) {
  const mid = (b.u0 + b.u1) / 2;
  const s = beatPoseU(beats, mid);
  if (b.id === 'hero') assert.equal(s, 0);
  else assert.ok(s >= b.u0 && s <= b.u1, `${b.id} pose inside its beat`);
}

// Captions: one per beat, numbers from the run, and the wording rules hold.
{
  const caps = beatCaptions(run);
  assert.deepEqual(caps.map((c) => c.id), beats.map((b) => b.id));
  const all = caps.map((c) => `${c.text} ${c.approval ?? ''}`).join(' ');
  assert.ok(!/failed code|found \d+ bugs?|passed review/i.test(all), 'no verdicts and no "failed code"');
  assert.match(caps.find((c) => c.id === 'verify')!.text, /command denied/);
  assert.match(caps.find((c) => c.id === 'verify')!.text, /cron failed its tests and was finished by a fixer branch \(cronfix\)/);
  assert.match(caps.find((c) => c.id === 'verify')!.text, /template and wrap failed their first tests and were resumed/);
  assert.match(caps.find((c) => c.id === 'merge')!.text, /before the cross-model review/);
  assert.match(caps.find((c) => c.id === 'review')!.text, /annex pass \(review-fixes\)/);
  assert.equal(caps.find((c) => c.id === 'plan')!.approval, 'Plan approval was automatic in this headless run.');
  const bill = caps.find((c) => c.id === 'bill')!.text;
  assert.ok(bill.includes(`$${run.cost_usd.toFixed(2)}`), 'cost from the run');
  assert.match(bill, /quota, not dollars/);
  assert.match(bill, /not recorded for cron/);
  assert.ok(!/cron \d/.test(bill), 'no token count for cron');
  assert.match(replayLabel(run), /^One real run \(run 2 of 2\), not a median/);
}

console.log('scene-logic: ok');
