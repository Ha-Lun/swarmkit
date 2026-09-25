// Checks the globe layout (src/lib/world/honeycomb.ts + sphere.ts) against the agent roster in ../core/agents.
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
    contents: "export { loadAgents } from './src/lib/agents.ts'; export { CELL_RADIUS } from './src/lib/world/config.ts'; export { layoutLattice, GLOBE_FREQ } from './src/lib/world/honeycomb.ts'; export { buildSphere } from './src/lib/world/sphere.ts';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { loadAgents, layoutLattice, buildSphere, GLOBE_FREQ, CELL_RADIUS } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const agents = loadAgents();
const lat = layoutLattice(agents);
const sphere = buildSphere(GLOBE_FREQ);
const F = GLOBE_FREQ;
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };

const globe = lat.cells.filter((c) => !c.moon);
const moon = lat.cells.filter((c) => c.moon);
const pent = globe.filter((c) => c.sides === 5).length;
console.log(`cells: ${lat.cells.length} total = ${globe.length} globe (${globe.length - pent} hex + ${pent} pentagon) + ${moon.length} moon; agents ${agents.length}; maxRing ${lat.maxRing}; radius ${lat.radius.toFixed(3)}; mean hex circumradius ${lat.cellRadius.toFixed(3)}`);

check(F === 5, `globe is GP(5,0) (freq ${F})`);
check(globe.length === 252 && globe.length === 10 * F * F + 2, `globe cell count is 10*f^2+2 = 252 (got ${globe.length})`);
check(globe.length - pent === 240, `240 hexagons (got ${globe.length - pent})`);
check(pent === 12, `exactly 12 pentagons (got ${pent})`);

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

// no overlap: prism footprints (circumradius = CELL_RADIUS * scale) must not intersect neighbours; centres must all differ
let minGap = Infinity, minCentre = Infinity, worst = '';
for (let i = 0; i < lat.cells.length; i++) for (let j = i + 1; j < lat.cells.length; j++) {
  const a = lat.cells[i], b = lat.cells[j];
  const d = a.pos.distanceTo(b.pos);
  minCentre = Math.min(minCentre, d);
  // inradius of each footprint (apothem = circumradius * cos(pi/n)); touching when d = apothemA + apothemB
  const ap = (c) => CELL_RADIUS * c.scale * Math.cos(Math.PI / c.sides);
  const gap = d - ap(a) - ap(b);
  if (gap < minGap) { minGap = gap; worst = `${i}-${j}`; }
}
check(minCentre > 0.5, `no coincident centres (min centre distance ${minCentre.toFixed(3)})`);
check(minGap > 0, `no overlapping footprints, min apothem gap ${minGap.toFixed(3)} world units (pair ${worst})`);
const moonToGlobe = Math.min(...moon.map((m) => Math.min(...globe.map((g) => m.pos.distanceTo(g.pos) - g.height))));
check(moonToGlobe > 2, `moon cluster clear of the globe (closest ${moonToGlobe.toFixed(2)} units)`);

// no missing cells: the polygons must tile the sphere (sum of spherical areas = 4 pi)
const tri = (a, b, c) => {
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const cr = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  return 2 * Math.atan2(Math.abs(dot(a, cr(b, c))), 1 + dot(a, b) + dot(b, c) + dot(c, a));
};
let area = 0;
sphere.cells.forEach((c) => c.corners.forEach((k, i) => (area += tri(c.center, k, c.corners[(i + 1) % c.corners.length]))));
check(Math.abs(area - 4 * Math.PI) < 1e-6, `cell polygons tile the sphere: area sum ${area.toFixed(6)} vs 4pi ${(4 * Math.PI).toFixed(6)}`);
const spacing = [];
sphere.cells.forEach((c, i) => c.neighbours.forEach((j) => j > i && spacing.push(Math.hypot(...c.center.map((v, k) => v - sphere.cells[j].center[k])))));
console.log(`neighbour spacing on the unit sphere: min ${Math.min(...spacing).toFixed(4)} max ${Math.max(...spacing).toFixed(4)} ratio ${(Math.max(...spacing) / Math.min(...spacing)).toFixed(3)}`);
const scales = globe.map((c) => c.scale);
console.log(`cell footprint scale: min ${Math.min(...scales).toFixed(3)} max ${Math.max(...scales).toFixed(3)}`);
const pm = globe.filter((c) => c.sides === 5).map((c) => c.scale);
console.log(`pentagon scale mean ${(pm.reduce((a, b) => a + b, 0) / pm.length).toFixed(3)} vs hex mean ${(scales.reduce((a, b) => a + b, 0) / scales.length).toFixed(3)}`);

console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nlayout OK');
process.exit(fails.length ? 1 : 0);
