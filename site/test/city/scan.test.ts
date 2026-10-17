// Plain node asserts: `node site/test/city/scan.test.ts` from the repo root.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Box3, Group, LineSegments, Mesh, Vector3 } from 'three';
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

// Cross-model review covers only the NEW lots: the bounding rectangle of the
// merged block slots plus the annex slots of building extras, with a margin.
// It must not reach old-town buildings (layout.existing) outside those bounds.
{
  const TEST_MARGIN = 1.2;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let i = 0; i < layout.lots.length; i++) {
    const lot = layout.lots[i];
    if (lot === undefined || lot.extra) continue;
    const s = layout.block[i];
    if (s === undefined) continue;
    bx0 = Math.min(bx0, s.x - s.w / 2);
    bx1 = Math.max(bx1, s.x + s.w / 2);
    bz0 = Math.min(bz0, s.z - s.d / 2);
    bz1 = Math.max(bz1, s.z + s.d / 2);
  }
  let ax0 = Infinity, ax1 = -Infinity, az0 = Infinity, az1 = -Infinity;
  for (const s of layout.annex) {
    ax0 = Math.min(ax0, s.x - s.w / 2);
    ax1 = Math.max(ax1, s.x + s.w / 2);
    az0 = Math.min(az0, s.z - s.d / 2);
    az1 = Math.max(az1, s.z + s.d / 2);
  }
  const hasAnnex = layout.annex.length > 0 && ax0 <= ax1 && az0 <= az1;
  const cx0 = hasAnnex ? Math.min(bx0, ax0) : bx0;
  const cx1 = hasAnnex ? Math.max(bx1, ax1) : bx1;
  const cz0 = hasAnnex ? Math.min(bz0, az0) : bz0;
  const cz1 = hasAnnex ? Math.max(bz1, az1) : bz1;
  const cross = findByName('scan-ind-cross');
  const box = new Box3();
  function barXZ() {
    part.object.updateMatrixWorld(true);
    box.setFromObject(cross);
    return { x0: box.min.x, x1: box.max.x, z0: box.min.z, z1: box.max.z };
  }
  function outsideExisting(x0: number, x1: number, z0: number, z1: number) {
    return layout.existing.filter((b) => {
      const ex0 = b.x - b.w / 2, ex1 = b.x + b.w / 2;
      const ez0 = b.z - b.d / 2, ez1 = b.z + b.d / 2;
      return ex1 < x0 - TEST_MARGIN || ex0 > x1 + TEST_MARGIN || ez1 < z0 - TEST_MARGIN || ez0 > z1 + TEST_MARGIN;
    });
  }
  function checkBar(x0: number, x1: number, z0: number, z1: number, label: string) {
    const r = barXZ();
    assert.ok(r.x0 >= x0 - TEST_MARGIN && r.x1 <= x1 + TEST_MARGIN, `${label} bar x within slots (${r.x0},${r.x1} vs ${x0},${x1})`);
    assert.ok(r.z0 >= z0 - TEST_MARGIN && r.z1 <= z1 + TEST_MARGIN, `${label} bar z within slots (${r.z0},${r.z1} vs ${z0},${z1})`);
    const outside = outsideExisting(x0, x1, z0, z1);
    assert.ok(outside.length > 0, `${label} has old-town buildings outside the new-lot bounds`);
    for (const b of outside) {
      const ex0 = b.x - b.w / 2, ex1 = b.x + b.w / 2;
      const ez0 = b.z - b.d / 2, ez1 = b.z + b.d / 2;
      const hit = !(r.x1 < ex0 || r.x0 > ex1 || r.z1 < ez0 || r.z0 > ez1);
      assert.ok(!hit, `${label} bar does not reach old-town building at (${b.x},${b.z})`);
    }
  }
  // Real cross-model scans (target null, extras not yet building): base bounds.
  let sawCrossNull = false;
  for (let i = 0; i <= STEPS; i++) {
    const s = timeline.stateAt(i / STEPS);
    if (s.activeScan.kind !== 'cross-model-review' || s.activeScan.target !== null) continue;
    sawCrossNull = true;
    part.update(s, 1 / 60);
    assert.ok(cross.visible, `cross bar visible at u=${s.u}`);
    checkBar(bx0, bx1, bz0, bz1, `cross u=${s.u}`);
  }
  assert.ok(sawCrossNull, 'found a null-target cross-model scan');
  // Synthetic: an extra is building, so the sweep extends to the annex.
  if (hasAnnex) {
    const base = timeline.stateAt(0.75);
    base.activeScan = { kind: 'cross-model-review', target: null, progress: 0.5 };
    for (const x of base.extras) x.build = 1;
    part.update(base, 1 / 60);
    checkBar(cx0, cx1, cz0, cz1, 'cross+annex p=0.5');
    for (const p of [0, 1]) {
      base.activeScan = { kind: 'cross-model-review', target: null, progress: p };
      part.update(base, 1 / 60);
      checkBar(cx0, cx1, cz0, cz1, `cross+annex p=${p}`);
    }
  }
}

part.dispose();
part.dispose();

console.log('scan.test.ts: ok');
