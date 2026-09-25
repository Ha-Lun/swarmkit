// Samples the whole camera journey against scroll distance and reports speed and acceleration at the four chapter boundaries.
// Run from site/:  node scripts/smoothness-check.mjs   (exits 1 if any boundary has an acceleration spike)
// Works on the camera path alone (no damping, no lenis): the strictest view, since the world's damping only smooths further.
// Scroll distance S is in viewport heights, chapters laid end to end with the runways of motion-config.ts.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'smooth-check-'));
const out = join(dir, 'bundle.mjs');
await build({
  stdin: {
    contents: "export { loadAgents } from './src/lib/agents.ts'; export * as cam from './src/lib/world/camera-path.ts'; export { layoutLattice } from './src/lib/world/honeycomb.ts'; export { motion } from './src/lib/world/motion-config.ts'; export { Vector3 } from 'three';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { loadAgents, cam, layoutLattice, motion, Vector3 } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const lattice = layoutLattice(loadAgents());
const L = lattice.radius;
const path = cam.createCameraPath(lattice);
const names = ['intro', 'hive', 'cells', 'proof', 'finale'];
const runway = names.map((n) => motion.runway[n]);
const total = runway.reduce((a, b) => a + b, 0);
const bounds = []; // cumulative scroll (vh) at the start of each chapter
runway.reduce((acc, r, i) => (bounds.push(acc), acc + r), 0);

// scroll distance -> (chapter, chapterProgress) -> global progress, exactly as scroll.ts does it
const progressAt = (S) => {
  let i = 0;
  while (i < 4 && S >= bounds[i + 1]) i++;
  const p = Math.min(1, Math.max(0, (S - bounds[i]) / runway[i]));
  return typeof cam.scrollToProgress === 'function' ? cam.scrollToProgress(i, p) : cam.SEGMENTS[i].t0 + p * (cam.SEGMENTS[i].t1 - cam.SEGMENTS[i].t0);
};
const pos = new Vector3(), tgt = new Vector3();
const sample = (S) => { path.sample(progressAt(S), pos, tgt); return [pos.clone().divideScalar(L), tgt.clone().divideScalar(L)]; };

const h = 0.05; // vh
const N = Math.round(total / h);
const P = [], T = [];
for (let i = 0; i <= N; i++) { const [p, t] = sample(i * h); P.push(p); T.push(t); }
const speed = (arr, i) => arr[i + 1].distanceTo(arr[i - 1]) / (2 * h) * 100; // L per 100vh
const acc = (arr, i) => arr[i + 1].clone().sub(arr[i].clone().multiplyScalar(2)).add(arr[i - 1]).length() / (h * h) * 1e4 / 1e4; // L per vh^2
const accv = (arr, i) => arr[i + 1].clone().sub(arr[i].clone().multiplyScalar(2)).add(arr[i - 1]).divideScalar(h * h);
const idxOf = (S) => Math.round(S / h);

const fails = [];
console.log(`journey ${total}vh, runways ${runway.join('/')}, samples every ${h}vh, units: globe radius L`);
for (const [label, arr] of [['camera position', P], ['look-at target', T]]) {
  const sp = [], ac = [];
  for (let i = 3; i < N - 3; i++) { sp.push(speed(arr, i)); ac.push(accv(arr, i).length()); }
  const sorted = [...ac].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const med = [...sp].sort((a, b) => a - b)[Math.floor(sp.length / 2)];
  const at = (a, f) => (a.indexOf(Math.max(...a)) + 3) * h * (f ? 1 : 1);
  console.log(`\n${label}: max speed ${Math.max(...sp).toFixed(3)} at ${at(sp).toFixed(1)}vh, max |accel| at ${at(ac).toFixed(1)}vh`);
  console.log(`${label}: max speed ${Math.max(...sp).toFixed(3)} L/100vh (median ${med.toFixed(3)}), max |accel| ${Math.max(...ac).toFixed(5)} L/vh^2 (p95 ${p95.toFixed(5)})`);
  console.log('  boundary        speed- -> speed+   (jump)    accel jump |a+ - a-| / p95|accel|');
  for (let b = 1; b < 5; b++) {
    const i = idxOf(bounds[b]);
    const s0 = speed(arr, i - 3), s1 = speed(arr, i + 3);
    const jump = accv(arr, i + 3).sub(accv(arr, i - 3)).length();
    const ratio = jump / p95;
    const ok = ratio < 0.5;
    if (!ok) fails.push(`${label} ${names[b - 1]}|${names[b]} accel spike ${ratio.toFixed(2)}x`);
    console.log(`  ${(names[b - 1] + '|' + names[b]).padEnd(13)} ${s0.toFixed(3).padStart(8)} -> ${s1.toFixed(3).padEnd(8)} (${(((s1 - s0) / Math.max(s0, 1e-6)) * 100).toFixed(1).padStart(6)}%)   ${ratio.toFixed(3).padStart(7)}  ${ok ? 'PASS' : 'FAIL'}`);
  }
}
console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nsmoothness OK: no acceleration spike at the four chapter boundaries (threshold 0.5 x p95 |accel|)');
process.exit(fails.length ? 1 : 0);
