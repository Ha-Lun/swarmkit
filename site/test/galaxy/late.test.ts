import assert from 'node:assert/strict';
import {
  bubbleAmt, fixWindow, growAmt, L, lateCam, lateOpacity, lateU, launchK, legacyP, SPLIT, starAt, starDest, sweepRange, sweepTime, destTheta,
} from '../../src/lib/galaxy/path.ts';

// page progress splits cleanly into the legacy beats and the late beats
assert.equal(legacyP(SPLIT), 1);
assert.equal(lateU(SPLIT), 0);
assert.equal(lateU(1), 1);
assert.equal(legacyP(0), 0);

const n = 8;
// launches are staggered by index, finish by the end of the fan window, and start at the constellation slot
for (let j = 0; j < n; j++) {
  assert.equal(launchK(0, j, n), 0);
  assert.equal(launchK(L.fan[1] + 0.001, j, n), 1);
  if (j) assert.ok(launchK(0.1, j, n) <= launchK(0.1, j - 1, n));
}
const s: [number, number, number] = [0.5, 0.2, 0];
const d = starDest(3, n, 1.6);
const out: [number, number, number] = [0, 0, 0];
assert.deepEqual(starAt(out, s, d, 3, 0).map((v) => +v.toFixed(9)), s);
assert.deepEqual(starAt(out, s, d, 3, 1).map((v) => +v.toFixed(9)), d.map((v) => +v.toFixed(9)));

// rest points stay inside the disc, and the sweep meets the stars in launch order
for (const asp of [1.6, 0.46]) {
  for (let j = 0; j < n; j++) assert.ok(Math.hypot(...starDest(j, n, asp)) < 7, `star ${j} inside the disc at aspect ${asp}`);
}
const th = Array.from({ length: n }, (_, j) => destTheta(j, n));
const [a0, a1] = sweepRange(th);
for (let j = 1; j < n; j++) assert.ok(sweepTime(th[j], a0, a1) > sweepTime(th[j - 1], a0, a1));
assert.ok(sweepTime(th[0], a0, a1) > L.sweep[0] && sweepTime(th[n - 1], a0, a1) < L.sweep[1]);

// build happens after the bubbles start and finishes before the sweep; fixers fly after the sweep
assert.ok(bubbleAmt(L.bubble[0] - 0.001, 0, n) === 0);
assert.ok(growAmt(L.build[1], n - 1, n) === 1 && growAmt(L.build[0], 0, n) === 0);
assert.ok(L.build[1] < L.sweep[0] && fixWindow(0, 1)[0] >= L.sweep[1]);

// the late camera is continuous and the beat copy handover has no long empty stretch
for (const asp of [1.6, 0.46]) {
  let prev = lateCam(0, asp).cam;
  for (let i = 1; i <= 500; i++) {
    const c = lateCam(i / 500, asp).cam;
    assert.ok(Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]) < 0.2);
    prev = c;
  }
}
let gap = 0;
let worst = 0;
for (let i = 0; i <= 1000; i++) {
  const u = i / 1000;
  gap = lateOpacity.planOut(u) + lateOpacity.fan(u) + lateOpacity.build(u) + lateOpacity.verify(u) < 0.5 ? gap + 0.001 : 0;
  worst = Math.max(worst, gap);
}
assert.ok(worst <= 0.06, `late copy gap ${worst}`);
