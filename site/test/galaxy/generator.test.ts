import assert from 'node:assert/strict';
import { buildGalaxy, buildNewArm, buildNebulaStars, GALAXY_R, KNOT_R, LOBES, NEBULA_R } from '../../src/lib/galaxy/generator.ts';

const a = buildGalaxy(4000, 3);
const b = buildGalaxy(4000, 3);
assert.deepEqual(a.position.slice(0, 60), b.position.slice(0, 60), 'deterministic');
let maxR = 0;
let finite = true;
for (let i = 0; i < a.count; i++) {
  const r = Math.hypot(a.position[i * 3], a.position[i * 3 + 2]);
  maxR = Math.max(maxR, r);
  for (let k = 0; k < 3; k++) if (!Number.isFinite(a.position[i * 3 + k]) || !Number.isFinite(a.color[i * 3 + k])) finite = false;
}
assert.ok(finite);
assert.ok(maxR < GALAXY_R * 1.4, `bounded, got ${maxR}`);
// colour by radius: arm stars far out lean to a lane colour (teal arm = more green than red)
let teal = 0;
let n = 0;
for (let i = 0; i < a.count; i += 2) {
  const r = Math.hypot(a.position[i * 3], a.position[i * 3 + 2]);
  if (r > 6 && r < 9) { n++; if (a.color[i * 3 + 1] > a.color[i * 3]) teal++; }
}
assert.ok(n > 0 && teal / n > 0.4);

// the new arm (grown by the merge) is deterministic, inside the disc, and carries its radius in data.w for the grow mask
{
  const a = buildNewArm(2000);
  const b = buildNewArm(2000);
  assert.deepEqual(a.position, b.position);
  let maxR = 0;
  for (let i = 0; i < a.count; i++) {
    const t = a.data[i * 4 + 3];
    assert.ok(t > 0 && t <= 1);
    maxR = Math.max(maxR, Math.hypot(a.position[i * 3], a.position[i * 3 + 2]));
    assert.ok(a.color[i * 3] >= 0 && a.color[i * 3 + 1] >= 0 && a.color[i * 3 + 2] >= 0);
  }
  assert.ok(maxR < GALAXY_R * 1.05);
}

// the nebula volume layout is shared with the ray-marcher: lobes sit inside the nebula, the knot clears them
for (const l of LOBES) {
  assert.ok(Math.hypot(...l.c) < NEBULA_R, 'lobe inside the nebula');
  assert.ok(l.m >= 0 && l.m <= 1);
  for (const s of l.s) assert.ok(s > 0);
}
assert.ok(KNOT_R > 0 && KNOT_R < 2);

// young stars: deterministic, right count, finite, bounded well inside the sky
{
  const a = buildNebulaStars(3000);
  const b = buildNebulaStars(3000);
  assert.deepEqual(a.position, b.position, 'deterministic');
  assert.equal(a.count, 3000);
  let maxR = 0;
  for (let i = 0; i < a.count; i++) {
    maxR = Math.max(maxR, Math.hypot(a.position[i * 3], a.position[i * 3 + 1], a.position[i * 3 + 2]));
    for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(a.position[i * 3 + k]) && Number.isFinite(a.color[i * 3 + k]));
  }
  assert.ok(maxR < NEBULA_R * 1.4, `bounded, got ${maxR}`);
}

// young stars: non-negative colours
{
  const a = buildNebulaStars(2000);
  for (let i = 0; i < a.count; i++) assert.ok(a.color[i * 3] >= 0 && a.color[i * 3 + 1] >= 0 && a.color[i * 3 + 2] >= 0);
}
