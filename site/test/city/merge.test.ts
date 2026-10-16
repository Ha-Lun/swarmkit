// Plain node asserts: `node site/test/city/merge.test.ts` from the repo root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Object3D } from 'three';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { createMerge } from '../../src/lib/city/merge.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { CityPalette } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const layout = buildLayout(run);
const timeline = buildTimeline(run);

const palette: CityPalette = {
  paper: '#f2ede3',
  ink: '#222222',
  line: '#999999',
  lightWarm: '#ffedb8',
  laneAgy: '#2f6fed',
  laneOpencode: '#e07b39',
  ok: '#2e9e44',
  fail: '#d33f2e',
};

const part = createMerge(layout, palette);

interface Tagged extends Object3D {
  userData: { kind?: unknown; slug?: unknown };
}

const footprints: Tagged[] = [];
const roads: Tagged[] = [];
const annexes: Tagged[] = [];
let block: Tagged | null = null;
part.object.traverse((o: Object3D) => {
  const kind = (o as Tagged).userData.kind;
  if (kind === 'footprint') footprints.push(o as Tagged);
  else if (kind === 'road') roads.push(o as Tagged);
  else if (kind === 'annex') annexes.push(o as Tagged);
  else if (kind === 'block') block = o as Tagged;
});

const nOriginal = layout.lots.filter((l) => !l.extra).length;
assert.equal(footprints.length, nOriginal, 'one footprint plate per original lot');
assert.equal(footprints.length, timeline.stateAt(1).workers.length, 'footprints line up with workers');
assert.equal(roads.length, layout.roads.length, 'one strip per road');
assert.ok(roads.length > 0, 'the real run has roads');
assert.equal(annexes.length, layout.annex.length, 'one plate per annex slot');

function assertFiniteScene(label: string): void {
  part.object.traverse((o: Object3D) => {
    for (const v of [o.position.x, o.position.y, o.position.z, o.scale.x, o.scale.y, o.scale.z]) {
      assert.ok(Number.isFinite(v), `${label}: non-finite transform`);
    }
  });
}

function assertFiniteMatrices(label: string): void {
  part.object.updateMatrixWorld(true);
  part.object.traverse((o: Object3D) => {
    for (const v of o.matrixWorld.elements) assert.ok(Number.isFinite(v), `${label}: non-finite matrix`);
  });
}

// Sweep u from 0 to 1 in 200 steps: nothing throws, everything reachable stays finite.
for (let i = 0; i <= 200; i++) {
  part.update(timeline.stateAt(i / 200), 1 / 60);
  assertFiniteScene(`u=${i / 200}`);
}
assertFiniteMatrices('sweep end');

// Same state, same picture: scrolling back rewinds exactly.
part.update(timeline.stateAt(0.3), 1 / 60);
const before = footprints.map((f) => [f.position.x, f.position.y, f.position.z].join(','));
part.update(timeline.stateAt(0.9), 1 / 60);
part.update(timeline.stateAt(0.3), 1 / 60);
assert.deepEqual(
  footprints.map((f) => [f.position.x, f.position.y, f.position.z].join(',')),
  before,
  'rewind is exact',
);

// The block ground plate exists at u = 0.
part.update(timeline.stateAt(0), 1 / 60);
assert.ok(block !== null, 'block ground plate exists');
assert.equal((block as Tagged).visible, true, 'block ground visible at u = 0');
assert.ok(Number.isFinite((block as Tagged).position.x), 'block ground positioned');
assertFiniteMatrices('u=0');

// Road strips have scale 0 at u = 0 and full length at u = 1.
assert.ok(roads.every((r) => r.scale.x === 0), 'roads start at scale 0');
part.update(timeline.stateAt(1), 1 / 60);
assertFiniteScene('u=1');
assertFiniteMatrices('u=1');
assert.ok(roads.every((r) => r.scale.x === 1), 'roads reach full length at u = 1');

// At u = 1 every footprint plate sits at its block slot (originals come first, so index f lines up).
const EPS = 1e-9;
footprints.forEach((f, i) => {
  assert.equal(f.userData.slug, layout.lots[i].slug, `footprint ${i} slug`);
  const slot = layout.block[i];
  assert.ok(Math.abs(f.position.x - slot.x) < EPS && Math.abs(f.position.z - slot.z) < EPS,
    `footprint ${String(f.userData.slug)} at its block slot`);
});
// Annex plates are fully grown at u = 1.
assert.ok(annexes.every((a) => a.scale.x === 1 && a.scale.z === 1), 'annex plates full at u = 1');

part.dispose();
part.dispose();

console.log('merge.test.ts: ok');
