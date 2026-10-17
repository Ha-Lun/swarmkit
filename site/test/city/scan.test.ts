// Plain node asserts: `node site/test/city/scan.test.ts` from the repo root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Group, LineSegments, Mesh, Vector3 } from 'three';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { createScan } from '../../src/lib/city/scan.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import type { CityPalette } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const layout = buildLayout(run);
const timeline = buildTimeline(run);
const palette: CityPalette = {
  paper: '#f4efe4',
  ink: '#20242b',
  line: '#9aa0a8',
  lightWarm: '#e8c87a',
  laneAgy: '#3a7bd5',
  laneOpencode: '#8a3ab5',
  ok: '#2ca02c',
  fail: '#d62728',
};
const part = createScan(layout, palette);
assert.ok(part.object);
assert.equal(typeof part.update, 'function');
assert.equal(typeof part.dispose, 'function');

function findByName(name: string) {
  const found = part.object.getObjectByName(name);
  assert.ok(found, `expected object named ${name}`);
  return found;
}

function checkFinite(label: string): void {
  part.object.updateMatrixWorld(true);
  part.object.traverse((o) => {
    assert.ok(Number.isFinite(o.position.x) && Number.isFinite(o.position.y) && Number.isFinite(o.position.z), `${label} position finite`);
    const els = o.matrix.elements;
    for (let i = 0; i < els.length; i++) {
      const v = els[i];
      assert.ok(typeof v === 'number' && Number.isFinite(v), `${label} matrix finite`);
    }
  });
}

const STEPS = 200;
let sawNullKind = false;
let sawScanVisible = false;
const kindsSeen: Set<string> = new Set();
for (let i = 0; i <= STEPS; i++) {
  const s = timeline.stateAt(i / STEPS);
  part.update(s, 1 / 60);
  checkFinite(`u=${s.u}`);
  const verify = findByName('scan-ind-verify');
  const orch = findByName('scan-ind-orch');
  const cross = findByName('scan-ind-cross');
  const kind = s.activeScan.kind;
  if (kind === null) {
    sawNullKind = true;
    assert.ok(!verify.visible && !orch.visible && !cross.visible, `indicator invisible at u=${s.u}`);
  } else if (kind === 'verify') {
    kindsSeen.add(kind);
    assert.ok(verify.visible && !orch.visible && !cross.visible, `verify ring shown at u=${s.u}`);
    sawScanVisible = true;
  } else if (kind === 'orchestrator-review') {
    kindsSeen.add(kind);
    assert.ok(orch.visible && !verify.visible && !cross.visible, `orchestrator ring shown at u=${s.u}`);
    sawScanVisible = true;
  } else if (kind === 'cross-model-review') {
    kindsSeen.add(kind);
    assert.ok(cross.visible && !verify.visible && !orch.visible, `cross-model bar shown at u=${s.u}`);
    sawScanVisible = true;
  }
}
assert.ok(sawNullKind, 'sweep includes idle (kind null) states');
assert.ok(sawScanVisible, 'indicator visible during some scan');
assert.ok(kindsSeen.has('verify'), 'sweep shows a verify scan');
assert.ok(kindsSeen.has('orchestrator-review'), 'sweep shows an orchestrator review');
assert.ok(kindsSeen.has('cross-model-review'), 'sweep shows a cross-model review');

// At the end every worker passed, so at least one tick marker is visible.
part.update(timeline.stateAt(1), 1 / 60);
checkFinite('u=1');
// Markers are meshes only: no line-based shapes anywhere in the part.
let lineCount = 0;
part.object.traverse((o) => {
  if (o instanceof LineSegments) lineCount++;
});
assert.equal(lineCount, 0, 'scan markers use meshes, not LineSegments');
const tickGroups: Group[] = [];
const clothMeshes: Mesh[] = [];
part.object.traverse((o) => {
  if (o.name.indexOf('scan-tick-') === 0) tickGroups.push(o as Group);
  if (o instanceof Mesh && o.name.indexOf('scan-flag-cloth-') === 0) clothMeshes.push(o);
});
assert.ok(tickGroups.length > 0, 'tick markers exist');
assert.ok(clothMeshes.length > 0, 'flag cloths exist');
assert.ok(tickGroups.some((t) => t.visible), 'at least one tick marker visible at the end');
// Every tick is built from Mesh bars, not lines.
for (const t of tickGroups) {
  let meshKids = 0;
  t.traverse((o) => {
    if (o instanceof Mesh) meshKids++;
    assert.ok(!(o instanceof LineSegments), 'tick contains no LineSegments');
  });
  assert.ok(meshKids > 0, 'tick group holds Mesh bars');
}
const firstTick = tickGroups[0];
const firstCloth = clothMeshes[0];
assert.ok(firstTick !== undefined && firstCloth !== undefined);
let tickBarGeo: unknown = null;
firstTick.traverse((o) => {
  if (o instanceof Mesh && tickBarGeo === null) tickBarGeo = o.geometry;
});
assert.ok(tickBarGeo !== null, 'tick bar geometry found');
const tickGeo = tickBarGeo as { getAttribute(n: string): { count: number } };
const clothGeo = firstCloth.geometry;
assert.ok(tickGeo !== (clothGeo as unknown), 'tick and flag geometries are different objects');
const tickCount = tickGeo.getAttribute('position').count;
const clothCount = clothGeo.getAttribute('position').count;
assert.ok(tickCount !== clothCount, `tick (${tickCount}) and flag (${clothCount}) vertex counts differ`);

// A visible marker floats above its lot's building top (lot.height * build).
{
  const s = timeline.stateAt(1);
  part.update(s, 1 / 60);
  part.object.updateMatrixWorld(true);
  let checked = 0;
  const lotBySlug = new Map(layout.lots.map((l) => [l.slug, l]));
  for (let k = 0; k < s.workers.length; k++) {
    const w = s.workers[k];
    if (w === undefined || (w.scan !== 'passed' && w.scan !== 'flagged')) continue;
    const lot = lotBySlug.get(w.slug);
    if (lot === undefined) continue;
    const marker = part.object.getObjectByName('scan-marker-' + w.slug);
    assert.ok(marker, `marker for ${w.slug} exists`);
    const p = new Vector3();
    marker.getWorldPosition(p);
    const top = lot.height * w.build;
    assert.ok(p.y > top, `marker for ${w.slug} floats above roof (${p.y} > ${top})`);
    checked++;
  }
  assert.ok(checked > 0, 'checked at least one visible marker above its roof');
}

// Rewind: the same state draws the same picture.
part.update(timeline.stateAt(0.5), 1 / 60);
const before: number[] = [];
part.object.traverse((o) => before.push(o.position.x, o.position.y, o.position.z));
part.update(timeline.stateAt(0.1), 1 / 60);
part.update(timeline.stateAt(0.5), 1 / 60);
const after: number[] = [];
part.object.traverse((o) => after.push(o.position.x, o.position.y, o.position.z));
assert.deepEqual(after, before);

part.dispose();
part.dispose();

console.log('scan.test.ts: ok');
