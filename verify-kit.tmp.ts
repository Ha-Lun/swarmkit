// Throwaway verification: kit paths of buildings/drones with a synthetic kit (no GLB fetch).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createBuildings } from './site/src/lib/city/buildings.ts';
import { createDrones } from './site/src/lib/city/drones.ts';
import { buildLayout } from './site/src/lib/city/lots.ts';
import { buildTimeline } from './site/src/lib/city/timeline.ts';

const run = JSON.parse(readFileSync(new URL('./site/public/data/featured-run.json', import.meta.url), 'utf8'));
const layout = buildLayout(run);
const timeline = buildTimeline(run);
const palette = {
  paper: '#f2ede3', ink: '#20242e', line: '#8b93a5', lightWarm: '#ffd9a0',
  laneAgy: '#2f6fed', laneOpencode: '#0fa36a', ok: '#2e9e44', fail: '#d64545',
};

const kitMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
function box(w, h, d) {
  return new THREE.BoxGeometry(w, h, d);
}
function mod(name, w, h, d, lane) {
  const g = new THREE.Group();
  g.name = name;
  const base = new THREE.Mesh(box(w, h, d), kitMat);
  base.name = `${name}-base`;
  base.position.y = h / 2;
  g.add(base);
  if (lane) {
    const l = new THREE.Mesh(box(w * 1.02, h, d * 1.02), kitMat);
    l.name = `${name}_lane`;
    l.position.y = h / 2;
    g.add(l);
  }
  return g;
}
const templates = new Map();
for (const n of ['body_a', 'body_b', 'body_c']) templates.set(n, mod(n, 2.52, 1, 2.52, true));
templates.set('roof_flat', mod('roof_flat', 2.62, 0.28, 2.62, true));
templates.set('roof_pitched', mod('roof_pitched', 2.66, 0.8, 2.62, true));
templates.set('roof_box', mod('roof_box', 1.67, 1, 1.12, false));
templates.set('scaffold', mod('scaffold', 2.82, 1, 2.82, true));
templates.set('annex', mod('annex', 1.62, 1.44, 1.62, true));
const drone = new THREE.Group();
drone.name = 'drone';
drone.add(new THREE.Mesh(box(0.5, 0.2, 0.5), kitMat));
const dlane = new THREE.Mesh(box(0.4, 0.15, 0.4), kitMat);
dlane.name = 'drone_lane';
dlane.position.y = 0.2;
drone.add(dlane);
for (const [rn, x, z] of [['rotor_fl', -0.3, 0.3], ['rotor_fr', 0.3, 0.3], ['rotor_bl', -0.3, -0.3], ['rotor_br', 0.3, -0.3]]) {
  const r = new THREE.Mesh(box(0.3, 0.02, 0.06), kitMat);
  r.name = rn;
  r.position.set(x, 0.3, z);
  drone.add(r);
}
const cable = new THREE.Mesh(box(0.02, 0.085, 0.02), kitMat);
cable.name = 'hook_cable';
cable.position.y = 0.13;
drone.add(cable);
const head = new THREE.Mesh(box(0.06, 0.06, 0.06), kitMat);
head.name = 'hook_head';
head.position.y = 0.045;
drone.add(head);
templates.set('drone', drone);
const depot = new THREE.Group();
depot.name = 'depot';
depot.add(new THREE.Mesh(box(3.4, 2, 3.6), kitMat));
const dplane = new THREE.Mesh(box(1, 1, 1), kitMat);
dplane.name = 'depot_lane';
depot.add(dplane);
templates.set('depot', depot);

const kit = { material: kitMat, templates, dispose() {} };

function assertFinite(root, what) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    for (const v of [o.position.x, o.position.y, o.position.z]) assert.ok(Number.isFinite(v), `${what} position finite`);
    if (o.isInstancedMesh) {
      for (const a of o.instanceMatrix.array) assert.ok(Number.isFinite(a), `${what} matrix finite`);
      if (o.instanceColor) for (const a of o.instanceColor.array) assert.ok(Number.isFinite(a), `${what} color finite`);
    }
  });
}

const b = createBuildings(layout, palette, kit);
const STEPS = 200;
for (let i = 0; i <= STEPS; i++) {
  b.update(timeline.stateAt(i / STEPS), 1 / 60);
  assertFinite(b.object, 'kit buildings');
}
b.update(timeline.stateAt(1), 1 / 60);
{
  const probe = new THREE.Matrix4();
  let checked = 0;
  for (const name of ['buildings-body-body_a', 'buildings-body-body_b', 'buildings-body-body_c']) {
    const mesh = b.object.getObjectByName(name);
    assert.ok(mesh && mesh.isInstancedMesh, `${name} present`);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, probe);
      assert.ok(probe.elements[5] > 1.5, `${name}[${i}] stands tall`);
      checked++;
    }
  }
  assert.ok(checked === layout.lots.filter((l) => !l.extra).length, 'every original has a body');
  const anx = b.object.getObjectByName('buildings-annex');
  assert.ok(anx && anx.isInstancedMesh, 'annex present');
}
b.update(timeline.stateAt(0.5), 0);
const snapA = [];
b.object.traverse((o) => { if (o.isInstancedMesh) snapA.push(...o.instanceMatrix.array); });
b.update(timeline.stateAt(0.5), 0);
const snapB = [];
b.object.traverse((o) => { if (o.isInstancedMesh) snapB.push(...o.instanceMatrix.array); });
assert.deepEqual(snapB, snapA);
b.dispose();
b.dispose();

const dz = createDrones(layout, palette, kit);
for (let i = 0; i <= STEPS; i++) {
  dz.update(timeline.stateAt(i / STEPS), 1 / 60);
  assertFinite(dz.object, 'kit drones');
}
{
  const rotor = dz.object.getObjectByName('rotor_fl');
  assert.ok(rotor, 'rotor found in a cloned drone');
  const y0 = rotor.rotation.y;
  dz.update(timeline.stateAt(0.5), 0.016);
  assert.ok(rotor.rotation.y > y0, 'rotor spins with dt');
}
dz.update(timeline.stateAt(0.4), 0);
const pa = [];
dz.object.traverse((o) => pa.push(o.position.x, o.position.y, o.position.z));
dz.update(timeline.stateAt(0.4), 0);
const pb = [];
dz.object.traverse((o) => pb.push(o.position.x, o.position.y, o.position.z));
assert.deepEqual(pb, pa);
dz.dispose();
dz.dispose();

console.log('verify-kit: ok');
