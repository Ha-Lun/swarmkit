// Checks the globe and moon layout (src/lib/world/honeycomb.ts + sphere.ts) against the agent roster in ../core/agents.
// Run from site/:  node scripts/layout-check.mjs   (exits 1 on any failure)
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'layout-check-'));
const out = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: "export { loadAgents } from './src/lib/agents.ts'; export { look } from './src/lib/world/config.ts'; export { layoutLattice, GLOBE_FREQ, MOON_FREQ, footprint, cellFrame } from './src/lib/world/honeycomb.ts'; export { buildSphere } from './src/lib/world/sphere.ts';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { loadAgents, layoutLattice, buildSphere, GLOBE_FREQ, MOON_FREQ, footprint, cellFrame, look } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const agents = loadAgents();
const lat = layoutLattice(agents);
const sphere = buildSphere(GLOBE_FREQ);
const moonSphere = buildSphere(MOON_FREQ);
const F = GLOBE_FREQ;
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };

const globe = lat.cells.filter((c) => !c.moon);
const moon = lat.cells.filter((c) => c.moon);
const pent = globe.filter((c) => c.sides === 5).length;
const mpent = moon.filter((c) => c.sides === 5).length;
console.log(`cells: ${lat.cells.length} total = ${globe.length} globe (${globe.length - pent} hex + ${pent} pentagon) + ${moon.length} moon (${moon.length - mpent} hex + ${mpent} pentagon); agents ${agents.length}; maxRing ${lat.maxRing}; radius ${lat.radius.toFixed(3)}; mean hex circumradius ${lat.cellRadius.toFixed(3)}`);

check(F === 5, `globe is GP(5,0) (freq ${F})`);
check(globe.length === 252 && globe.length === 10 * F * F + 2, `globe cell count is 10*f^2+2 = 252 (got ${globe.length})`);
check(globe.length - pent === 240, `240 hexagons (got ${globe.length - pent})`);
check(pent === 12, `exactly 12 pentagons (got ${pent})`);
check(MOON_FREQ === 2 && moon.length === 10 * MOON_FREQ * MOON_FREQ + 2 && moon.length === 42, `moon is a GP(2,0) sphere with 42 cells (got ${moon.length})`);
check(moon.length - mpent === 30 && mpent === 12, `moon has 30 hexagons and exactly 12 pentagons (got ${moon.length - mpent} + ${mpent})`);
check(moonSphere.cells.length === moon.length && moonSphere.cells.every((c, i) => c.neighbours.length === c.sides && c.neighbours.every((j) => moonSphere.cells[j].neighbours.includes(i))), 'moon valence and neighbour symmetry');

const val = sphere.cells.map((c) => c.neighbours.length);
check(val.every((n, i) => n === sphere.cells[i].sides) && val.filter((n) => n === 5).length === 12 && val.filter((n) => n === 6).length === globe.length - 12, 'valence: 12 cells with 5 neighbours, the rest with 6, sides match');
check(sphere.cells.every((c, i) => c.neighbours.every((j) => sphere.cells[j].neighbours.includes(i))), 'neighbour relation is symmetric');

// every agent exactly once
const seen = new Map();
lat.cells.forEach((c) => c.agent && seen.set(c.agent.name, (seen.get(c.agent.name) ?? 0) + 1));
const missing = agents.filter((a) => !seen.has(a.name)).map((a) => a.name);
const dup = [...seen].filter(([, n]) => n !== 1).map(([k]) => k);
check(!missing.length && !dup.length && seen.size === agents.length, `every agent placed exactly once (${seen.size}/${agents.length}${missing.length ? `, missing ${missing}` : ''}${dup.length ? `, duplicated ${dup}` : ''})`);
const band = (b) => lat.cells.filter((c) => c.agent?.band === b);
check(band('core').length === 1 && !band('core')[0].moon && band('core')[0].ring === 0 && band('core')[0].normal.z > 0.999, 'lead-dev is the single core cell at ring 0 on +Z');
check(band('satellite').every((c) => c.moon) && moon.filter((c) => c.agent).length === band('satellite').length, 'satellite agents are exactly the moon cluster agents');
console.log('agents per band/ring (geodesic ring):');
for (const b of ['core', 't1', 'domain', 'gate', 'satellite']) {
  const rings = {};
  band(b).forEach((c) => (rings[c.ring] = (rings[c.ring] ?? 0) + 1));
  console.log(`  ${b.padEnd(9)} ${band(b).length} in rings ${JSON.stringify(rings)}`);
}
const used = ['core', 't1', 'domain', 'gate'].flatMap((b) => [...new Set(band(b).map((c) => c.ring))].sort((a, z) => a - z));
check(used.every((r, i) => r === i), `bands occupy consecutive geodesic rings with no gap (rings ${used})`);
const order = ['core', 't1', 'domain', 'gate'].map((b) => Math.max(...band(b).map((c) => c.ring)));
check(order.every((r, i) => i === 0 || r > order[i - 1]), `bands are ordered outward by ring (outermost ring per band ${order})`);

// no overlap and an even seam: every panel footprint is its Voronoi polygon inset by half the seam. For every neighbour pair, the gap
// between the two inset footprints along the line between the centres must be the seam width, everywhere on the globe and on the moon.
let minCentre = Infinity;
for (let i = 0; i < lat.cells.length; i++) for (let j = i + 1; j < lat.cells.length; j++) minCentre = Math.min(minCentre, lat.cells[i].pos.distanceTo(lat.cells[j].pos));
check(minCentre > 0.5, `no coincident centres (min centre distance ${minCentre.toFixed(3)})`);
const along = (poly, ux, uz) => { // distance from the origin to the polygon edge along direction (ux, uz)
  let best = Infinity;
  for (let k = 0; k < poly.length / 2; k++) {
    const ax = poly[k * 2], az = poly[k * 2 + 1], bx = poly[((k + 1) % (poly.length / 2)) * 2], bz = poly[((k + 1) % (poly.length / 2)) * 2 + 1];
    const ex = bx - ax, ez = bz - az, den = ux * ez - uz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ez - az * ex) / den, u = (ax * uz - az * ux) / den;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
};
const gaps = { globe: [], moon: [] };
const seamOf = (c) => (c.moon ? look.cell.seam * 0.7 : look.cell.seam);
const bodies = [[0, sphere, 'globe'], [globe.length, moonSphere, 'moon']];
for (const [off, sph, name] of bodies) {
  sph.cells.forEach((sc, i) => sc.neighbours.forEach((j) => {
    if (j < i) return;
    const a = lat.cells[off + i], b = lat.cells[off + j];
    // the panel top follows its sphere, so measure the gap as arc length on the sphere: a footprint reaching a (planar, in the tangent plane) covers R * asin(a / R)
    const reach = (c, o) => {
      const f = cellFrame(c), d = o.pos.clone().sub(c.pos);
      const ux = d.dot(f.x), uz = d.dot(f.z), L = Math.hypot(ux, uz);
      const a = along(footprint(c, seamOf(c)), ux / L, uz / L);
      return c.bodyRadius * Math.asin(Math.min(1, a / c.bodyRadius));
    };
    const theta = Math.acos(Math.min(1, a.normal.dot(b.normal)));
    gaps[name].push({ gap: a.bodyRadius * theta - reach(a, b) - reach(b, a), pair: `${off + i}-${off + j}`, want: seamOf(a) });
  }));
}
for (const name of ['globe', 'moon']) {
  const g = gaps[name].map((x) => x.gap), want = gaps[name][0].want;
  const mn = Math.min(...g), mx = Math.max(...g), mean = g.reduce((a, b) => a + b, 0) / g.length;
  console.log(`${name} seam: ${g.length} neighbour pairs, gap min ${mn.toFixed(4)} mean ${mean.toFixed(4)} max ${mx.toFixed(4)} (target ${want.toFixed(4)}, spread ${(mx - mn).toFixed(4)})`);
  check(mn > 0, `${name}: no overlapping footprints (min gap ${mn.toFixed(4)} world units)`);
  check(mn > 0.95 * want && mx < 1.1 * want, `${name}: seam is even, every gap within 5-10% of ${want.toFixed(3)}`);
}
const moonToGlobe = Math.min(...moon.map((m) => Math.min(...globe.map((g) => m.pos.distanceTo(g.pos) - g.reach - m.reach))));
check(moonToGlobe > 2, `moon cluster clear of the globe (closest ${moonToGlobe.toFixed(2)} units)`);

// no missing cells: the polygons must tile the sphere (sum of spherical areas = 4 pi)
const tri = (a, b, c) => {
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  return 2 * Math.atan2(Math.abs(dot(a, cr(b, c))), 1 + dot(a, b) + dot(b, c) + dot(c, a));
};
for (const [name, sph] of [['globe', sphere], ['moon', moonSphere]]) {
  let area = 0;
  sph.cells.forEach((c) => c.corners.forEach((k, i) => (area += tri(c.center, k, c.corners[(i + 1) % c.corners.length]))));
  check(Math.abs(area - 4 * Math.PI) < 1e-6, `${name} cell polygons tile the sphere: area sum ${area.toFixed(6)} vs 4pi ${(4 * Math.PI).toFixed(6)}`);
}
const spacing = [];
sphere.cells.forEach((c, i) => c.neighbours.forEach((j) => j > i && spacing.push(Math.hypot(...c.center.map((v, k) => v - sphere.cells[j].center[k])))));
console.log(`neighbour spacing on the unit sphere: min ${Math.min(...spacing).toFixed(4)} max ${Math.max(...spacing).toFixed(4)} ratio ${(Math.max(...spacing) / Math.min(...spacing)).toFixed(3)}`);
const scales = globe.map((c) => c.scale);
console.log(`panel footprint circumradius: min ${Math.min(...scales).toFixed(3)} max ${Math.max(...scales).toFixed(3)}`);
const pm = globe.filter((c) => c.sides === 5).map((c) => c.scale);
console.log(`pentagon circumradius mean ${(pm.reduce((a, b) => a + b, 0) / pm.length).toFixed(3)} vs hex mean ${(scales.reduce((a, b) => a + b, 0) / scales.length).toFixed(3)}`);
// terrain: every resting column stands between relief and relief + elevation, never above 0.9 world units, quantised into look.cell.steps levels;
// a filler rod can drive out up to look.cell.stroke more (reach), so the tallest a column ever stands is 0.9 + stroke; agents sit on a steady mid-range shelf
const hs = lat.cells.map((c) => c.base);
const top = look.cell.relief + look.cell.elevation;
check(Math.min(...hs) >= look.cell.relief - 1e-9 && Math.max(...hs) <= Math.min(top, 0.9) + 1e-9, `resting heights within [${look.cell.relief}, ${Math.min(top, 0.9)}] (got ${Math.min(...hs).toFixed(3)}..${Math.max(...hs).toFixed(3)})`);
const reach = Math.max(...lat.cells.map((c) => c.reach));
check(reach <= 0.9 + look.cell.stroke + 1e-9 && reach > Math.max(...hs), `tallest reach ${reach.toFixed(3)} = resting + full stroke, within 0.9 + ${look.cell.stroke}`);
check(lat.cells.every((c) => c.height === c.base), 'layout leaves every column at rest (the pistons are driven by update(time))');
check(globe.some((c) => c.base > look.cell.relief + 0.15), 'the globe has real relief (a column stands 0.15+ above the base)');
const levels = new Set(globe.filter((c) => !c.agent).map((c) => c.base.toFixed(4)));
check(levels.size <= look.cell.steps && levels.size >= 3, `basalt heights snap to at most ${look.cell.steps} levels (got ${levels.size})`);
const ag = globe.filter((c) => c.agent).map((c) => c.base);
check(Math.min(...ag) >= look.cell.relief + look.cell.elevation * 0.5 - 1e-9 && Math.max(...ag) <= look.cell.relief + look.cell.elevation * 0.7 + 1e-9, `agent panels sit on a steady mid-range shelf (${Math.min(...ag).toFixed(3)}..${Math.max(...ag).toFixed(3)})`);
check(globe.every((c) => Math.abs(c.pos.length() - lat.radius) < 1e-9), 'every globe panel sits at the same radius');
check(moon.every((c) => Math.abs(c.pos.distanceTo(lat.moon.centre) - c.bodyRadius) < 1e-9), 'every moon panel sits at the same radius from the moon centre');
check(moon.some((c) => c.agent?.name === 'showroom') && moon.every((c) => c.normal.dot(lat.moon.normal) > -1.01), 'showroom is on the moon');

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nlayout OK');
process.exit(fails.length ? 1 : 0);
