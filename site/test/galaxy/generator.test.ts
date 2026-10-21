import assert from 'node:assert/strict';
import { buildGalaxy, buildNewArm, buildNebula, buildNebulaDust, buildNebulaStars, GALAXY_R, NEBULA_R } from '../../src/lib/galaxy/generator.ts';

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

// the emission nebula builders: deterministic per seed, right count, finite, and bounded well inside the sky
for (const build of [buildNebula, buildNebulaDust, buildNebulaStars]) {
  const a = build(3000);
  const b = build(3000);
  assert.deepEqual(a.position, b.position, 'deterministic');
  assert.equal(a.count, 3000);
  let maxR = 0;
  let finite = true;
  for (let i = 0; i < a.count; i++) {
    const r = Math.hypot(a.position[i * 3], a.position[i * 3 + 1], a.position[i * 3 + 2]);
    maxR = Math.max(maxR, r);
    for (let k = 0; k < 3; k++) if (!Number.isFinite(a.position[i * 3 + k]) || !Number.isFinite(a.color[i * 3 + k])) finite = false;
  }
  assert.ok(finite);
  assert.ok(maxR < NEBULA_R * 1.4, `bounded, got ${maxR}`);
}

// the gas peaks hard at the knot and is a real 3D volume, not a flat disc
{
  const a = buildNebula(4000);
  let inner = 0;
  let sx = 0;
  let sxx = 0;
  let sy = 0;
  let syy = 0;
  for (let i = 0; i < a.count; i++) {
    const x = a.position[i * 3];
    const y = a.position[i * 3 + 1];
    const z = a.position[i * 3 + 2];
    if (Math.hypot(x, y, z) < 1) inner++;
    sx += x;
    sxx += x * x;
    sy += y;
    syy += y * y;
  }
  const f = inner / a.count;
  const uniformFrac = (1 / NEBULA_R) ** 3; // fraction of a uniform ball of radius NEBULA_R inside radius 1
  assert.ok(f >= 5 * uniformFrac, `knot density peak, got ${f} vs ${5 * uniformFrac}`);
  const dx = Math.sqrt(sxx / a.count - (sx / a.count) ** 2);
  const dy = Math.sqrt(syy / a.count - (sy / a.count) ** 2);
  assert.ok(dy >= 0.35 * dx, `not rotationally flat, dy/dx = ${dy / dx}`);
}

// dust lanes: pure alpha in colour.x, and never over the knot
{
  const a = buildNebulaDust(2000);
  for (let i = 0; i < a.count; i++) {
    assert.equal(a.color[i * 3 + 1], 0);
    assert.equal(a.color[i * 3 + 2], 0);
    assert.ok(a.color[i * 3] >= 0.06 && a.color[i * 3] <= 0.16, `alpha in range, got ${a.color[i * 3]}`);
    const r = Math.hypot(a.position[i * 3], a.position[i * 3 + 1], a.position[i * 3 + 2]);
    assert.ok(r >= 1.2, `dust clears the knot, got ${r}`);
  }
}

// young stars: non-negative colours
{
  const a = buildNebulaStars(2000);
  for (let i = 0; i < a.count; i++) assert.ok(a.color[i * 3] >= 0 && a.color[i * 3 + 1] >= 0 && a.color[i * 3 + 2] >= 0);
}
