import assert from 'node:assert/strict';
import {
  blastFlash, burstFlash, formK, shakeAt, debrisK, closeAmt, closeC, closeView, coreFlare, L, LATE_END, lateOpacity, lateU, legacyP, M, mergeCam, mergeM, mergeOpacity,
  pullEnd, pullK, shipK, SPLIT, STATIC_POSE, systemView, viewPose, win,
} from '../../src/lib/galaxy/path.ts';
import type { V3 } from '../../src/lib/galaxy/path.ts';

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// page progress splits cleanly into the legacy beats and the late beats
assert.equal(legacyP(SPLIT), 1);
assert.equal(lateU(SPLIT), 0);
assert.equal(lateU(LATE_END), 1);
assert.equal(mergeM(LATE_END), 0);
assert.equal(mergeM(1), 1);
assert.ok(SPLIT < LATE_END && LATE_END < 1);
assert.equal(legacyP(0), 0);

// the late windows run in story order: launch, build, scan (plus one flash), fly in, dwell, pull back
assert.ok(L.fan[1] <= L.build[0] && L.build[1] <= L.scan[0]);
assert.ok(L.scan[1] + L.tick <= L.fly[0], 'every planet is green before the camera leaves the overview');
assert.ok(L.fly[1] <= L.dwell[0] && L.dwell[1] <= L.out[0] && L.out[1] <= 1);
assert.equal(win(L.fan, 0), 0);
assert.equal(win(L.fan, 1), 1);

// the close-up: overview camera outside it, planet-framed inside the dwell, back to the overview at u = 1
assert.equal(closeAmt(0), 0);
assert.equal(closeAmt(L.fly[0]), 0);
assert.equal(closeAmt(L.dwell[0]), 1);
assert.equal(closeAmt(L.dwell[1]), 1);
assert.equal(closeAmt(1), 0);
assert.equal(closeC(L.dwell[0]), 0);
assert.equal(closeC(L.dwell[1]), 1);
// the fixer flies from the bubble wall, starts during the fly-in and arrives beside cron once its three sputters end (c = 0.5)
assert.equal(shipK(L.ship[0]), 0);
assert.equal(shipK(L.ship[1]), 1);
assert.ok(L.ship[0] < L.dwell[0], 'the ship is already on its way as the camera arrives');
const dockC = (L.ship[1] - L.dwell[0]) / (L.dwell[1] - L.dwell[0]);
assert.ok(dockC > 0.4 && dockC <= 0.5, `dock at c=${dockC}`);

// poses: the cameras are finite, continuous in the planet's position, and the merge camera starts on the overview
for (const asp of [1.6, 0.46]) {
  const ov = systemView(asp, 6);
  assert.ok(ov.cam.every(Number.isFinite) && ov.target.every(Number.isFinite));
  assert.ok(dist(ov.cam, [0, 0, 0]) > 10, 'the overview sees the whole system from a distance');
  assert.deepEqual(mergeCam(0, asp, 6).cam.map((v) => +v.toFixed(9)), ov.cam.map((v) => +v.toFixed(9)), 'merge camera starts on the overview');
  let prev = mergeCam(0, asp, 6).cam;
  for (let i = 1; i <= 800; i++) {
    const c = mergeCam(i / 800, asp, 6).cam;
    assert.ok(dist(c, prev) < 0.25, 'merge camera is continuous');
    prev = c;
  }
  // close-up: a few units from the star (scaled to its size), and it follows the star as it moves (small steps for small steps)
  let pc = closeView([3.4, 0, 0], asp).cam;
  assert.ok(dist(pc, [3.4, 0, 0]) < 6);
  for (let i = 1; i <= 200; i++) {
    const a = (i / 200) * 0.6;
    const c = closeView([3.4 * Math.cos(a), 0, 3.4 * Math.sin(a)], asp).cam;
    assert.ok(dist(c, pc) < 0.2);
    pc = c;
  }
}
// viewPose with no offset looks straight at the focus
{
  const v = viewPose([1, 0.5, -2], 10, 0.4, 0.3, 0, 0, 1.6);
  assert.deepEqual(v.target.map((x) => +x.toFixed(9)), [1, 0.5, -2]);
  assert.ok(Math.abs(dist(v.cam, v.target) - 10) < 1e-9);
}

// ---- merge ----
// planets fall in merge order and arrive by the end of the pull window
const n = 8;
for (let r = 0; r < n; r++) {
  assert.equal(pullK(0, r, n), 0);
  assert.equal(pullK(M.pull[1] + 0.001, r, n), 1);
  if (r) assert.ok(pullEnd(r, n) > pullEnd(r - 1, n), 'merge order is staggered');
}
// the sun flare is bounded (never blown out) and peaks after arrivals, then settles
let peak = 0;
for (let i = 0; i <= 2000; i++) peak = Math.max(peak, coreFlare(i / 2000, n));
assert.ok(peak > 0.3 && peak < 0.95, `flare peak ${peak}`);
assert.ok(coreFlare(1, n) < 0.05 && coreFlare(0, n) < 0.01);
assert.equal(coreFlare(0.5, 0), 0);
// supernova: burst then formation, ordered, inside the merge; formK is a monotonic 0..1
assert.ok(M.pull[0] < M.burst[0] && M.burst[0] < M.burst[1] && M.burst[1] < M.form[1] && M.form[1] <= 1, 'burst and form are ordered');
assert.ok(M.form[0] >= M.burst[0] && M.form[0] < M.form[1] && M.form[0] > 0 && M.burst[0] > M.pull[0], 'form starts at the burst');
assert.equal(formK(0), 0);
assert.equal(formK(1), 1);
for (let i = 1; i <= 500; i++) assert.ok(formK(i / 500) >= formK((i - 1) / 500), 'formK is monotonic');
assert.ok(burstFlash(0) === 0 && burstFlash(1) === 0 && burstFlash((M.burst[0] + 0.02)) > 0.9, 'flash peaks in the burst and is gone at the ends');
// the final merge view sits at about 42 deg elevation, wide and portrait
for (const asp of [1.6, 0.46]) {
  const c = mergeCam(1, asp, 6);
  const el = (Math.atan2(c.cam[1] - c.target[1], Math.hypot(c.cam[0] - c.target[0], c.cam[2] - c.target[2])) * 180) / Math.PI;
  assert.ok(el > 35 && el < 50, `final elevation ${el} at aspect ${asp}`);
}

// copy handover: no long empty stretch through the late beats
let gap = 0;
let worst = 0;
for (let i = 0; i <= 1000; i++) {
  const u = i / 1000;
  gap = lateOpacity.planOut(u) + lateOpacity.fan(u) + lateOpacity.build(u) + lateOpacity.verify(u) < 0.5 ? gap + 0.001 : 0;
  worst = Math.max(worst, gap);
}
assert.ok(worst <= 0.06, `late copy gap ${worst}`);
// verify out before merge in, no long gap, merge copy gone before the close
let mgap = 0;
let mworst = 0;
for (let i = 0; i <= 800; i++) {
  const m = i / 1000;
  mgap = mergeOpacity.copy(m) + lateOpacity.verify(1) * mergeOpacity.verifyOut(m) < 0.4 ? mgap + 0.001 : 0;
  mworst = Math.max(mworst, mgap);
}
assert.ok(mworst <= 0.08, `merge copy gap ${mworst}`);
assert.equal(mergeOpacity.copy(1), 0);

// the reduced-motion poses are in scroll order
const poses = [STATIC_POSE.nebula, STATIC_POSE.core, STATIC_POSE.constellation, STATIC_POSE.fan, STATIC_POSE.build, STATIC_POSE.verify, STATIC_POSE.cron, STATIC_POSE.merge, STATIC_POSE.close];
for (let i = 1; i < poses.length; i++) assert.ok(poses[i] > poses[i - 1]);
// the verify pose is after the scan + ticks, before the fly-in; the cron pose is inside the dwell after the dock
const uOf = (P: number): number => lateU(P);
assert.ok(uOf(STATIC_POSE.verify) >= L.scan[1] + L.tick && uOf(STATIC_POSE.verify) < L.fly[0]);
assert.ok(uOf(STATIC_POSE.cron) > L.ship[1] && uOf(STATIC_POSE.cron) < L.dwell[1]);

// K4: the blast's white-out peaks in the burst and is gone soon after; the shake is deterministic and dies out; debris runs 0..1
assert.ok(blastFlash(0) === 0 && blastFlash(M.burst[0] + 0.008) > 0.9 && blastFlash(M.burst[1] + 0.1) === 0, 'blast flash envelope');
assert.deepEqual(shakeAt(M.burst[0] + 0.01), shakeAt(M.burst[0] + 0.01), 'shake is a pure function of m');
assert.ok(shakeAt(0)[0] === 0 && shakeAt(1)[1] === 0, 'no shake outside the burst');
assert.ok(debrisK(M.burst[0]) === 0 && debrisK(1) === 1, 'debris progress spans the burst to the settle');
