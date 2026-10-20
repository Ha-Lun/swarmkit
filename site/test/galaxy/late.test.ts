import assert from 'node:assert/strict';
import {
  armGrow, bubbleAmt, coreFlare, fixWindow, growAmt, L, LATE_END, lateCam, lateOpacity, lateU, launchK, legacyP, M, mergeAt, mergeCam, mergeM,
  mergeOpacity, pullEnd, pullK, SPLIT, starAt, starDest, sweepRange, sweepTime, destTheta,
} from '../../src/lib/galaxy/path.ts';

// page progress splits cleanly into the legacy beats and the late beats
assert.equal(legacyP(SPLIT), 1);
assert.equal(lateU(SPLIT), 0);
assert.equal(lateU(LATE_END), 1);
assert.equal(mergeM(LATE_END), 0);
assert.equal(mergeM(1), 1);
assert.ok(SPLIT < LATE_END && LATE_END < 1);
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

// ---- merge (beat 6) ----
// planets fall in merge order, arrive by the end of the pull window, and start/end exactly at the rest point / the core
for (let r = 0; r < n; r++) {
  assert.equal(pullK(0, r, n), 0);
  assert.equal(pullK(M.pull[1] + 0.001, r, n), 1);
  if (r) assert.ok(pullEnd(r, n) > pullEnd(r - 1, n), 'merge order is staggered');
}
for (let j = 0; j < n; j++) {
  const dd = starDest(j, n, 1.6);
  const o: [number, number, number] = [0, 0, 0];
  assert.deepEqual(mergeAt(o, dd, 0, j).map((v) => +v.toFixed(9)), dd.map((v) => +v.toFixed(9)));
  mergeAt(o, dd, 1, j);
  assert.ok(Math.hypot(...o) < 1e-6, 'every planet ends in the core');
  // the in-spiral is curved: the midpoint is off the straight line to the core
  mergeAt(o, dd, 0.5, j);
  const along = (o[0] * dd[0] + o[2] * dd[2]) / Math.hypot(dd[0], dd[2]);
  assert.ok(Math.abs(Math.hypot(o[0], o[2]) - along) > 0.2, `path ${j} curves`);
}
// the core flare is bounded (never blown out) and peaks after arrivals, then settles
let peak = 0;
for (let i = 0; i <= 2000; i++) peak = Math.max(peak, coreFlare(i / 2000, n));
assert.ok(peak > 0.3 && peak < 0.95, `flare peak ${peak}`);
assert.ok(coreFlare(1, n) < 0.05 && coreFlare(0, n) < 0.01);
assert.equal(coreFlare(0.5, 0), 0);
// the new arm and the camera
assert.equal(armGrow(0), 0);
assert.equal(armGrow(1), 1);
for (const asp of [1.6, 0.46]) {
  assert.deepEqual(mergeCam(0, asp).cam.map((v) => +v.toFixed(9)), lateCam(1, asp).cam.map((v) => +v.toFixed(9)), 'merge camera starts on the verify pose');
  let prev = mergeCam(0, asp).cam;
  for (let i = 1; i <= 800; i++) {
    const c = mergeCam(i / 800, asp).cam;
    assert.ok(Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]) < 0.25, 'merge camera is continuous');
    prev = c;
  }
}
// copy handover: verify out before merge in, no long gap, merge copy gone before the close
let mgap = 0;
let mworst = 0;
for (let i = 0; i <= 800; i++) {
  const m = i / 1000; // up to 0.8: after the merge copy fades the wide shot is deliberately empty
  mgap = mergeOpacity.copy(m) + lateOpacity.verify(m * 0 + 1) * mergeOpacity.verifyOut(m) < 0.4 ? mgap + 0.001 : 0;
  mworst = Math.max(mworst, mgap);
}
assert.ok(mworst <= 0.08, `merge copy gap ${mworst}`);
assert.equal(mergeOpacity.copy(1), 0);
