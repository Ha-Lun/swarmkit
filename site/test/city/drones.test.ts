// Plain node asserts: `node site/test/city/drones.test.ts` from the repo root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DRONES_PER_DEPOT, createDrones } from '../../src/lib/city/drones.ts';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { CityPalette } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));

const palette: CityPalette = {
  paper: '#f4efe6',
  ink: '#1c1a16',
  line: '#8a8474',
  lightWarm: '#ffd9a0',
  laneAgy: '#2e7dd1',
  laneOpencode: '#d1542e',
  ok: '#2e9e5b',
  fail: '#c22f2f',
};

/** Children per lane: depot mesh, then its drones. */
const PER = 1 + DRONES_PER_DEPOT;
const droneOf = (part: ReturnType<typeof createDrones>, k: number, d: number) =>
  part.object.children[k * PER + 1 + d];

const L = buildLayout(run);
const T = buildTimeline(run);
const part = createDrones(L, palette);

assert.equal(part.object.children.length, L.depots.length * PER, 'one depot plus three drones per lane');

const finiteObject = () => {
  part.object.updateMatrixWorld(true);
  part.object.traverse((o) => {
    assert.ok(Number.isFinite(o.position.x) && Number.isFinite(o.position.y) && Number.isFinite(o.position.z), 'finite position');
    const m = o.matrixWorld.elements;
    for (let j = 0; j < 16; j++) assert.ok(Number.isFinite(m[j]), 'finite matrixWorld');
  });
};

// Sweep the whole replay: nothing throws, everything reachable stays finite.
const STEPS = 200;
for (let i = 0; i <= STEPS; i++) {
  part.update(T.stateAt(i / STEPS), 1 / 60);
  finiteObject();
}

// At u = 0 no jobs exist, so every drone is parked at its depot.
assert.ok(T.stateAt(0).drones.every((d) => d.jobs.length === 0), 'no jobs before the run');
part.update(T.stateAt(0), 0);
L.depots.forEach((depot, k) => {
  for (let d = 0; d < DRONES_PER_DEPOT; d++) {
    const p = droneOf(part, k, d).position;
    const dist = Math.hypot(p.x - depot.x, p.z - depot.z);
    assert.ok(dist <= 1.6 && p.y < 1.0, `lane ${depot.lane} drone ${d} parked at its depot`);
  }
});

// During the lanes beat at least one drone is away from its depot and inside the bounds.
const lanesBeat = T.beats.find((b) => b.id === 'lanes')!;
const insideBounds = (x: number, z: number) =>
  Math.abs(x - L.bounds.x) <= L.bounds.w / 2 && Math.abs(z - L.bounds.z) <= L.bounds.d / 2;
let away = false;
for (let i = 0; i <= 120 && !away; i++) {
  const u = lanesBeat.u0 + ((lanesBeat.u1 - lanesBeat.u0) * i) / 120;
  part.update(T.stateAt(u), 1 / 60);
  for (let k = 0; k < L.depots.length && !away; k++) {
    for (let d = 0; d < DRONES_PER_DEPOT && !away; d++) {
      const p = droneOf(part, k, d).position;
      const dist = Math.hypot(p.x - L.depots[k].x, p.z - L.depots[k].z);
      if (dist > 1.0 && insideBounds(p.x, p.z)) away = true;
    }
  }
}
assert.ok(away, 'a drone leaves its depot during the lanes beat');

// Same state, same picture: two updates with a frozen clock agree exactly.
const uMid = (lanesBeat.u0 + lanesBeat.u1) / 2;
part.update(T.stateAt(uMid), 0);
const snapA: number[] = [];
for (let k = 0; k < L.depots.length; k++) {
  for (let d = 0; d < DRONES_PER_DEPOT; d++) {
    const p = droneOf(part, k, d).position;
    snapA.push(p.x, p.y, p.z);
  }
}
part.update(T.stateAt(uMid), 0);
const snapB: number[] = [];
for (let k = 0; k < L.depots.length; k++) {
  for (let d = 0; d < DRONES_PER_DEPOT; d++) {
    const p = droneOf(part, k, d).position;
    snapB.push(p.x, p.y, p.z);
  }
}
assert.deepEqual(snapB, snapA);

// An unused lane never moves: rebuild with agy workers only so opencode stays dark.
const agyOnly = {
  ...run,
  lanes: ['agy'],
  workers: run.workers.filter((w) => w.lane === 'agy'),
  events: run.events.filter((e) => !e.lane || e.lane !== 'opencode'),
} as FeaturedRun;
const L2 = buildLayout(agyOnly);
assert.equal(L2.depots[0].used, true);
assert.equal(L2.depots[1].used, false);
const T2 = buildTimeline(agyOnly);
assert.ok(T2.stateAt(0).drones[1].jobs.length === 0);
const part2 = createDrones(L2, palette);
// Unused depot is a low dark slab, not the tall lane-coloured box.
assert.ok(part2.object.children[PER].position.y < part2.object.children[0].position.y, 'unused depot is flat');
part2.update(T2.stateAt(0), 1 / 60);
const parked: number[][] = [];
for (let d = 0; d < DRONES_PER_DEPOT; d++) {
  const p = droneOf(part2, 1, d).position;
  parked.push([p.x, p.y, p.z]);
}
for (let i = 0; i <= STEPS; i++) {
  part2.update(T2.stateAt(i / STEPS), 1 / 60);
  for (let d = 0; d < DRONES_PER_DEPOT; d++) {
    const p = droneOf(part2, 1, d).position;
    assert.equal(p.x, parked[d][0], `unused drone ${d} never moves in x`);
    assert.equal(p.y, parked[d][1], `unused drone ${d} never moves in y`);
    assert.equal(p.z, parked[d][2], `unused drone ${d} never moves in z`);
  }
  assert.ok(T2.stateAt(i / STEPS).drones[1].jobs.length === 0, 'unused lane gets no jobs');
}

part.dispose();
part.dispose();
part2.dispose();
part2.dispose();

console.log('drones.test.ts: ok');
