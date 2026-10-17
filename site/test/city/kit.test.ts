// Plain node asserts: `node site/test/city/kit.test.ts` from the repo root. Pure kit helpers: the slug-hash
// variant picker in buildings.ts and the lane-split geometry baker in kit.ts (fed a synthetic kit, no GLB fetch),
// plus a full-replay sweep of the kit paths of buildings and drones against the same synthetic kit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, BoxGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from 'three';
import { createBuildings, hashSlug, pickVariant } from '../../src/lib/city/buildings.ts';
import { createDrones } from '../../src/lib/city/drones.ts';
import { kitPartGeometries } from '../../src/lib/city/kit.ts';
import type { Kit } from '../../src/lib/city/kit.ts';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

// --- pickVariant: deterministic, in range, and spread over variants.

// A spread of slug-like strings (worker slugs plus edge cases).
const SLUGS = [
  'cron', 'auth', 'review-fixes', 'search', 'a', 'zz', 'lane-9-worker', 'UPPER', 'with space', '........',
];

for (const slug of SLUGS) {
  assert.equal(pickVariant(slug, 3), pickVariant(slug, 3), `${slug} is deterministic`);
  assert.equal(hashSlug(slug), hashSlug(slug), `${slug} hash is deterministic`);
}
for (const count of [1, 2, 3, 5]) {
  for (const slug of SLUGS) {
    const v = pickVariant(slug, count);
    assert.ok(Number.isInteger(v) && v >= 0 && v < count, `pickVariant(${slug}, ${count}) = ${v} in range`);
  }
}
assert.equal(pickVariant('anything', 0), 0, 'non-positive count picks 0');
assert.equal(pickVariant('anything', -2), 0, 'negative count picks 0');

// The body pick spreads real slugs over all three variants (no degenerate hash).
const seen = new Set(SLUGS.map((s) => pickVariant(s, 3)));
assert.equal(seen.size, 3, `body variants all reachable, saw ${[...seen]}`);
// Different slugs do not all collide.
assert.ok(new Set(SLUGS.map((s) => hashSlug(s))).size > 1, 'hash separates slugs');

// --- kitPartGeometries: splits base from the `<name>_lane` subtree with transforms baked in.

function fakeKit(): Kit {
  const material = new MeshBasicMaterial();
  const root = new Group();
  root.name = 'mod';
  const base = new Mesh(new BoxGeometry(1, 1, 1), material);
  base.name = 'mod-base';
  root.add(base);
  const lane = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), material);
  lane.name = 'mod_lane';
  lane.position.set(0, 2, 0);
  root.add(lane);
  const templates = new Map([[root.name, root], [lane.name, lane]]);
  return { material, templates, dispose() {} };
}

const kit = fakeKit();
const geos = kitPartGeometries(kit, 'mod');
assert.ok(geos.base, 'base geometry present');
assert.ok(geos.lane, 'lane geometry present');
const baseBox = new Box3().setFromObject(new Mesh(geos.base!, new MeshBasicMaterial()));
const laneBox = new Box3().setFromObject(new Mesh(geos.lane!, new MeshBasicMaterial()));
// Base stays a unit box at the origin; the lane child keeps its +2 y offset baked in.
assert.ok(Math.abs(baseBox.min.y + 0.5) < 1e-6 && Math.abs(baseBox.max.y - 0.5) < 1e-6, 'base unbaked');
assert.ok(Math.abs(laneBox.min.y - 1.75) < 1e-6 && Math.abs(laneBox.max.y - 2.25) < 1e-6, 'lane offset baked');

const missing = kitPartGeometries(kit, 'nope');
assert.equal(missing.base, null, 'missing module has no base');
assert.equal(missing.lane, null, 'missing module has no lane');

// A module with no lane child yields a null lane.
const plain = new Group();
plain.name = 'plain';
plain.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
kit.templates.set('plain', plain);
const plainGeos = kitPartGeometries(kit, 'plain');
assert.ok(plainGeos.base, 'plain base present');
assert.equal(plainGeos.lane, null, 'plain lane null');

// --- Kit paths end to end: a synthetic kit with every node the parts need, swept over the whole replay.

function boxModule(name: string, w: number, h: number, d: number, lane: boolean, mat: MeshStandardMaterial): Group {
  const g = new Group();
  g.name = name;
  const base = new Mesh(new BoxGeometry(w, h, d), mat);
  base.name = `${name}-base`;
  base.position.y = h / 2;
  g.add(base);
  if (lane) {
    const l = new Mesh(new BoxGeometry(w * 1.02, h, d * 1.02), mat);
    l.name = `${name}_lane`;
    l.position.y = h / 2;
    g.add(l);
  }
  return g;
}

function fullKit(): Kit {
  const material = new MeshStandardMaterial({ color: 0xffffff });
  const templates = new Map<string, Object3D>();
  const put = (o: Group) => templates.set(o.name, o);
  for (const n of ['body_a', 'body_b', 'body_c']) put(boxModule(n, 2.52, 1, 2.52, true, material));
  put(boxModule('roof_flat', 2.62, 0.28, 2.62, true, material));
  put(boxModule('roof_pitched', 2.66, 0.8, 2.62, true, material));
  put(boxModule('roof_box', 1.67, 1, 1.12, false, material));
  put(boxModule('scaffold', 2.82, 1, 2.82, true, material));
  put(boxModule('annex', 1.62, 1.44, 1.62, true, material));
  const drone = new Group();
  drone.name = 'drone';
  drone.add(new Mesh(new BoxGeometry(0.5, 0.2, 0.5), material));
  const dlane = new Mesh(new BoxGeometry(0.4, 0.15, 0.4), material);
  dlane.name = 'drone_lane';
  dlane.position.y = 0.2;
  drone.add(dlane);
  const rotorDefs = [['rotor_fl', -0.3, 0.3], ['rotor_fr', 0.3, 0.3], ['rotor_bl', -0.3, -0.3], ['rotor_br', 0.3, -0.3]] as const;
  for (const [rn, x, z] of rotorDefs) {
    const r = new Mesh(new BoxGeometry(0.3, 0.02, 0.06), material);
    r.name = rn;
    r.position.set(x, 0.3, z);
    drone.add(r);
  }
  const cable = new Mesh(new BoxGeometry(0.02, 0.085, 0.02), material);
  cable.name = 'hook_cable';
  cable.position.y = 0.13;
  drone.add(cable);
  const hookHead = new Mesh(new BoxGeometry(0.06, 0.06, 0.06), material);
  hookHead.name = 'hook_head';
  hookHead.position.y = 0.045;
  drone.add(hookHead);
  put(drone);
  const depot = new Group();
  depot.name = 'depot';
  depot.add(new Mesh(new BoxGeometry(3.4, 2, 3.6), material));
  const depotLane = new Mesh(new BoxGeometry(1, 1, 1), material);
  depotLane.name = 'depot_lane';
  depot.add(depotLane);
  put(depot);
  return { material, templates, dispose() {} };
}

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

function assertFiniteKit(root: Group, what: string): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    assert.ok(Number.isFinite(o.position.x) && Number.isFinite(o.position.y) && Number.isFinite(o.position.z), `${what} position finite`);
    const m = o as Group & { isInstancedMesh?: boolean; instanceMatrix?: { array: ArrayLike<number> }; instanceColor?: { array: ArrayLike<number> } | null };
    if (m.isInstancedMesh && m.instanceMatrix) {
      for (const a of m.instanceMatrix.array) assert.ok(Number.isFinite(a), `${what} matrix finite`);
      if (m.instanceColor) for (const a of m.instanceColor.array) assert.ok(Number.isFinite(a), `${what} color finite`);
    }
  });
}

const kitFull = fullKit();
const kitBuildings = createBuildings(layout, palette, kitFull);
const STEPS = 200;
for (let i = 0; i <= STEPS; i++) {
  kitBuildings.update(timeline.stateAt(i / STEPS), 1 / 60);
  assertFiniteKit(kitBuildings.object as Group, 'kit buildings');
}
// At u = 1 every original stands full-height in one of the three body variants.
kitBuildings.update(timeline.stateAt(1), 1 / 60);
{
  const probe = new Matrix4();
  let bodies = 0;
  for (const name of ['buildings-body-body_a', 'buildings-body-body_b', 'buildings-body-body_c']) {
    const mesh = kitBuildings.object.getObjectByName(name);
    assert.ok(mesh, `${name} present`);
    const im = mesh as unknown as { count: number; getMatrixAt(i: number, m: Matrix4): void };
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, probe);
      assert.ok(probe.elements[5] > 1.5, `${name}[${i}] stands tall`);
      bodies++;
    }
  }
  assert.equal(bodies, layout.lots.filter((l) => !l.extra).length, 'every original has a body');
  assert.ok(kitBuildings.object.getObjectByName('buildings-annex'), 'annex present');
}
// Same state, same matrices.
kitBuildings.update(timeline.stateAt(0.5), 0);
const snapA: number[] = [];
kitBuildings.object.traverse((o) => {
  const m = o as unknown as { isInstancedMesh?: boolean; instanceMatrix?: { array: ArrayLike<number> } };
  if (m.isInstancedMesh && m.instanceMatrix) snapA.push(...m.instanceMatrix.array);
});
kitBuildings.update(timeline.stateAt(0.5), 0);
const snapB: number[] = [];
kitBuildings.object.traverse((o) => {
  const m = o as unknown as { isInstancedMesh?: boolean; instanceMatrix?: { array: ArrayLike<number> } };
  if (m.isInstancedMesh && m.instanceMatrix) snapB.push(...m.instanceMatrix.array);
});
assert.deepEqual(snapB, snapA);
kitBuildings.dispose();
kitBuildings.dispose();

const kitDrones = createDrones(layout, palette, kitFull);
for (let i = 0; i <= STEPS; i++) {
  kitDrones.update(timeline.stateAt(i / STEPS), 1 / 60);
  assertFiniteKit(kitDrones.object as Group, 'kit drones');
}
// Rotors spin with dt.
{
  const rotor = kitDrones.object.getObjectByName('rotor_fl');
  assert.ok(rotor, 'rotor found in a cloned drone');
  const y0 = rotor.rotation.y;
  kitDrones.update(timeline.stateAt(0.5), 0.016);
  assert.ok(rotor.rotation.y > y0, 'rotor spins with dt');
}
// Same state with a frozen clock gives the same picture.
kitDrones.update(timeline.stateAt(0.4), 0);
const pa: number[] = [];
kitDrones.object.traverse((o) => pa.push(o.position.x, o.position.y, o.position.z));
kitDrones.update(timeline.stateAt(0.4), 0);
const pb: number[] = [];
kitDrones.object.traverse((o) => pb.push(o.position.x, o.position.y, o.position.z));
assert.deepEqual(pb, pa);
kitDrones.dispose();
kitDrones.dispose();

console.log('kit.test.ts: ok');
