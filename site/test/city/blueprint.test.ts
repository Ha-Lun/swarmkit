import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import { createBlueprint } from '../../src/lib/city/blueprint.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(
  readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'),
);
const layout = buildLayout(run);
const timeline = buildTimeline(run);

const palette = {
  paper: '#f5f0e6',
  ink: '#1b1b1b',
  line: '#3a3a3a',
  lightWarm: '#ffd9a0',
  laneAgy: '#2a7fff',
  laneOpencode: '#ff5a2a',
  ok: '#2ca02c',
  fail: '#d62728',
};

const part = createBlueprint(layout, palette);

function lineObjects(): Array<{
  obj: { geometry: { drawRange: { count: number }; getAttribute: (name: string) => { count: number; array: ArrayLike<number> } | null };
    userData: Record<string, unknown> };
}> {
  const out: Array<{
    obj: { geometry: { drawRange: { count: number }; getAttribute: (name: string) => { count: number; array: ArrayLike<number> } | null };
      userData: Record<string, unknown> };
  }> = [];
  part.object.traverse((o) => {
    const cand = o as unknown as {
      isLineSegments?: boolean;
      isLine?: boolean;
      geometry?: { drawRange: { count: number }; getAttribute: (name: string) => { count: number; array: ArrayLike<number> } | null };
      userData?: Record<string, unknown>;
    };
    if ((cand.isLineSegments === true || cand.isLine === true) && cand.geometry) {
      out.push({ obj: cand as { geometry: { drawRange: { count: number }; getAttribute: (name: string) => { count: number; array: ArrayLike<number> } | null }; userData: Record<string, unknown> } });
    }
  });
  return out;
}

function assertSceneFinite(): void {
  part.object.updateMatrixWorld(true);
  part.object.traverse((o) => {
    for (const v of [o.position.x, o.position.y, o.position.z]) assert.ok(Number.isFinite(v), 'position finite');
    const els = o.matrix.elements;
    for (let i = 0; i < els.length; i++) assert.ok(Number.isFinite(els[i]), 'matrix finite');
    const g = (o as unknown as { geometry?: { getAttribute: (n: string) => { array: ArrayLike<number> } | null } }).geometry;
    if (g) {
      const pos = g.getAttribute('position');
      if (pos) {
        const arr = pos.array;
        for (let i = 0; i < arr.length; i++) assert.ok(Number.isFinite(arr[i]), 'vertex finite');
      }
    }
  });
}

// At u = 0 every line object draws 0 vertices.
part.update(timeline.stateAt(0), 1 / 60);
{
  const lines = lineObjects();
  assert.ok(lines.length > 0, 'has line objects');
  for (const { obj } of lines) assert.equal(obj.geometry.drawRange.count, 0, 'u=0 draws nothing');
  assertSceneFinite();
}

// Sweep u from 0 to 1 in 200 steps.
for (let i = 0; i <= 200; i++) {
  const u = i / 200;
  part.update(timeline.stateAt(u), 1 / 60);
  assertSceneFinite();
}

// Once the plan beat has finished, all lot outlines are fully drawn.
{
  const planBeat = timeline.beats.find((b) => b.id === 'plan');
  assert.ok(planBeat, 'plan beat exists');
  part.update(timeline.stateAt(planBeat.u1), 1 / 60);
  assertSceneFinite();
  const lines = lineObjects();
  const originalSlugs = new Set(layout.lots.filter((l) => !l.extra).map((l) => l.slug));
  const seen = new Set<string>();
  for (const { obj } of lines) {
    const slug = obj.userData.slug;
    if (typeof slug === 'string' && originalSlugs.has(slug)) {
      const pos = obj.geometry.getAttribute('position');
      assert.ok(pos, 'lot line has positions');
      assert.equal(obj.geometry.drawRange.count, pos.count, `${slug} fully drawn`);
      seen.add(slug);
    }
  }
  assert.equal(seen.size, originalSlugs.size, 'every lot outline fully drawn after plan');
}

part.dispose();
part.dispose();

console.log('blueprint.test.ts: ok');
