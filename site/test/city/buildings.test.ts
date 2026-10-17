// Plain node asserts: `node site/test/city/buildings.test.ts` from the repo root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createBuildings, FOOTPRINT } from '../../src/lib/city/buildings.ts';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const layout = buildLayout(run);
const timeline = buildTimeline(run);

const palette = {
  paper: '#f2ede3',
  ink: '#20242e',
  line: '#8b93a5',
  lightWarm: '#ffd9a0',
  laneAgy: '#2f6fed',
  laneOpencode: '#0fa36a',
  ok: '#2e9e44',
  fail: '#d64545',
};

const part = createBuildings(layout, palette);
assert.ok(part.object);

const mainMesh = part.object.getObjectByName('buildings-main');
const reworkMesh = part.object.getObjectByName('buildings-rework');
const extraMesh = part.object.getObjectByName('buildings-extras');
const oldMesh = part.object.getObjectByName('buildings-existing');
assert.ok(oldMesh instanceof THREE.InstancedMesh, 'existing-city InstancedMesh present');
assert.ok(layout.existing.length > 0);
assert.equal(oldMesh.count, layout.existing.length);
assert.ok(mainMesh instanceof THREE.InstancedMesh, 'main InstancedMesh present');
assert.ok(reworkMesh instanceof THREE.InstancedMesh, 'rework InstancedMesh present');
assert.ok(extraMesh instanceof THREE.InstancedMesh, 'extras InstancedMesh present');

const originals = layout.lots.filter((l) => !l.extra);
const annexLots = layout.lots.filter((l) => l.extra);
assert.equal(mainMesh.count, originals.length);
assert.equal(reworkMesh.count, originals.length);
assert.equal(extraMesh.count, annexLots.length);

function assertFinite(): void {
  part.object.traverse((o) => {
    assert.ok(
      Number.isFinite(o.position.x) && Number.isFinite(o.position.y) && Number.isFinite(o.position.z),
      'position finite',
    );
    if (o instanceof THREE.InstancedMesh) {
      const arr = o.instanceMatrix.array;
      for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i]), `matrix[${i}] finite`);
      if (o.instanceColor) {
        const carr = o.instanceColor.array;
        for (let i = 0; i < carr.length; i++) assert.ok(Number.isFinite(carr[i]), `color[${i}] finite`);
      }
    }
  });
}

const STEPS = 200;
for (let i = 0; i <= STEPS; i++) {
  part.update(timeline.stateAt(i / STEPS), 1 / 60);
  assertFinite();
}

const probe = new THREE.Matrix4();
const H_EPS = 1e-6;
const POS_EPS = 1e-4;

// The existing city stands from the first frame to the last, unchanged, in a neutral (non-lane) colour.
const laneColours = [new THREE.Color(palette.laneAgy), new THREE.Color(palette.laneOpencode)];
const oldAt = (u: number) => {
  part.update(timeline.stateAt(u), 1 / 60);
  return Array.from(oldMesh.instanceMatrix.array);
};
const old0 = oldAt(0);
assert.deepEqual(oldAt(0.62), old0);
assert.deepEqual(oldAt(1), old0);
const c = new THREE.Color();
for (let i = 0; i < layout.existing.length; i++) {
  const b = layout.existing[i];
  oldMesh.getMatrixAt(i, probe);
  const e = probe.elements;
  assert.ok(Math.abs(e[5] - b.height) < H_EPS && Math.abs(e[0] - b.w) < H_EPS && Math.abs(e[10] - b.d) < H_EPS, `existing ${i} size`);
  assert.ok(Math.abs(e[12] - b.x) < POS_EPS && Math.abs(e[14] - b.z) < POS_EPS && e[13] === 0, `existing ${i} grounded in place`);
  oldMesh.getColorAt(i, c);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  assert.ok(hsl.s < 0.5, `existing ${i} is a grey, not a lane colour`);
  for (const lc of laneColours) assert.ok(Math.abs(c.r - lc.r) + Math.abs(c.g - lc.g) + Math.abs(c.b - lc.b) > 0.3, `existing ${i} not a lane colour`);
}

// At u = 0 nothing is built: every instance height is about 0.
part.update(timeline.stateAt(0), 1 / 60);
for (let i = 0; i < originals.length; i++) {
  mainMesh.getMatrixAt(i, probe);
  assert.ok(Math.abs(probe.elements[5]) < H_EPS, `original ${i} starts flat`);
  reworkMesh.getMatrixAt(i, probe);
  assert.ok(Math.abs(probe.elements[5]) < H_EPS, `rework ${i} starts flat`);
}
for (let j = 0; j < annexLots.length; j++) {
  extraMesh.getMatrixAt(j, probe);
  assert.ok(Math.abs(probe.elements[5]) < H_EPS, `extra ${j} starts flat`);
}

// At u = 1 every original stands full-height in its block slot.
part.update(timeline.stateAt(1), 1 / 60);
assertFinite();
for (let i = 0; i < originals.length; i++) {
  mainMesh.getMatrixAt(i, probe);
  const e = probe.elements;
  assert.ok(Math.abs(e[5] - originals[i].height) < H_EPS, `original ${i} full height`);
  assert.ok(Math.abs(e[0] - originals[i].w * FOOTPRINT) < H_EPS && Math.abs(e[10] - originals[i].d * FOOTPRINT) < H_EPS, `original ${i} setback footprint`);
  assert.ok(Math.abs(e[12] - layout.block[i].x) < POS_EPS, `original ${i} at slot x`);
  assert.ok(Math.abs(e[13]) < 1e-9, `original ${i} grounded`);
  assert.ok(Math.abs(e[14] - layout.block[i].z) < POS_EPS, `original ${i} at slot z`);
}
for (let j = 0; j < annexLots.length; j++) {
  extraMesh.getMatrixAt(j, probe);
  const e = probe.elements;
  assert.ok(Math.abs(e[5] - annexLots[j].height) < H_EPS, `extra ${j} full height`);
  assert.ok(Math.abs(e[12] - layout.block[originals.length + j].x) < POS_EPS, `extra ${j} at slot x`);
  assert.ok(Math.abs(e[14] - layout.block[originals.length + j].z) < POS_EPS, `extra ${j} at slot z`);
}

part.dispose();
part.dispose();

console.log('buildings.test.ts: ok');
