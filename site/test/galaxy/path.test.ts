import assert from 'node:assert/strict';
import { beatOpacity, camRoute, cometAt, sceneState, spline, typedChars, T } from '../../src/lib/galaxy/path.ts';

// spline passes through its end points
assert.deepEqual(camRoute(0).map((v) => +v.toFixed(6)), [0, 7.6, 15.2]);
assert.deepEqual(camRoute(1).map((v) => +v.toFixed(6)), [0, 0.1, 2.9]);
assert.deepEqual(cometAt(1).map((v) => +v.toFixed(6)), [0, 0, 0]);
assert.deepEqual(spline([[0, 0, 0], [1, 1, 1]], 0.5), [0.5, 0.5, 0.5]);

// hero: nothing is flying yet; end: camera in the core, constellation fully drawn, pulse done
const a = sceneState(0);
assert.equal(a.cometVis, 0);
assert.equal(a.diveEnv, 0);
assert.equal(a.draw, 0);
const z = sceneState(1);
assert.equal(z.draw, 1);
assert.equal(z.pulse, 1);
assert.equal(z.cometVis, 0);
assert.ok(Math.hypot(...z.target) < 1e-9, 'ends looking at the core');

// determinism / scrub safety: same p gives the same state
assert.deepEqual(sceneState(0.37), sceneState(0.37));

// camera is continuous (no snaps) across the whole scroll
let prev = sceneState(0).cam;
for (let i = 1; i <= 2000; i++) {
  const c = sceneState(i / 2000).cam;
  assert.ok(Math.hypot(c[0] - prev[0], c[1] - prev[1], c[2] - prev[2]) < 0.2, `camera jump at ${i / 2000}`);
  prev = c;
}

// the dive pushes the FOV out and brings it back
assert.ok(sceneState(0.41).fov > sceneState(0.02).fov + 15);
assert.ok(Math.abs(sceneState(0.6).fov - sceneState(0).fov) < 1);

// copy handover: the only copy-free stretches are the comet streak-in and the calm core hold, each short
let gap = 0;
let worst = 0;
for (let i = 0; i <= 1000; i++) {
  const p = i / 1000;
  gap = beatOpacity.hero(p) + beatOpacity.task(p) + beatOpacity.plan(p) < 0.5 ? gap + 0.001 : 0;
  worst = Math.max(worst, gap);
}
assert.ok(worst <= 0.11, `copy gap ${worst}`);
assert.equal(typedChars(0, 66), 0);
assert.equal(typedChars(0.5, 66), 66);
assert.ok(T.pulse[0] > T.draw[1] - 1e-9);
