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
    contents: "export { loadAgents } from './src/lib/agents.ts'; export * as cam from './src/lib/world/camera-path.ts'; export { layoutLattice } from './src/lib/world/honeycomb.ts'; export { motion, walkWeight, walkCfg, walkRamp } from './src/lib/world/motion-config.ts'; export { createWalkRoute, walkCameraPose, walkBlendBase } from './src/lib/world/walk.ts'; export { Vector3, Quaternion } from 'three';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { loadAgents, cam, layoutLattice, motion, walkWeight, walkCfg, walkRamp, createWalkRoute, walkCameraPose, walkBlendBase, Vector3, Quaternion } = await import(pathToFileURL(out).href);
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

// ---- the walk: dive in, walk, rise out (the blended story camera, sampled through the exact function the world calls) ----
// Position, orientation (angle between consecutive quaternions) and FOV are sampled every h vh across the whole Cells chapter plus 60vh either side.
// A "jump" is a sample-to-sample step far above its neighbours: |second difference| more than 12x the p99.5 of the chapter (position and angle) or a
// first-difference step above a hard ceiling. The damping in the world only smooths further, so this is the strictest view.
{
  const route = createWalkRoute(lattice);
  const base = walkBlendBase(route, (p, o, t) => path.sample(cam.scrollToProgress(2, p), o, t), [[walkRamp.inFrom, walkRamp.inTo], [walkRamp.outFrom, walkRamp.outTo]], walkCfg);
  const cellsAt = bounds[2], cellsEnd = bounds[3];
  const from = cellsAt - 60, to = cellsEnd + 60;
  const wpos = new Vector3(), wq = new Quaternion(), splinePos = new Vector3(), splineTgt = new Vector3(), walker = { position: new Vector3(), quaternion: new Quaternion(), fov: 0, up: new Vector3(), forward: new Vector3(), ground: 0, stop: 0 };
  const poses = [];
  const HW = 0.1; // vh
  for (let S = from; S <= to; S += HW) {
    const g = progressAt(S);
    path.sample(g, splinePos, splineTgt);
    const dp = cam.progressOfG(g);
    const w = walkWeight(dp.chapter, dp.chapterProgress);
    let fov = 40, pos = splinePos.clone(), q = new Quaternion();
    if (w > 0.001) fov = walkCameraPose(route, base, splinePos, splineTgt, w, dp.chapterProgress, walkCfg, wpos, wq, walker), (pos = wpos.clone(), q = wq.clone());
    else { const m = new (splinePos.constructor)(); q = new Quaternion().setFromRotationMatrix(new (walker.quaternion.constructor === Quaternion ? (await import('three')).Matrix4 : null)().lookAt(splinePos, splineTgt, new Vector3(0, 1, 0))); }
    poses.push({ S, w, pos, q, fov });
  }
  const n = poses.length;
  const d1p = [], d1a = [], d1f = [], d2p = [], d2a = [];
  for (let i = 1; i < n; i++) {
    d1p.push(poses[i].pos.distanceTo(poses[i - 1].pos) / L);
    d1a.push(2 * Math.acos(Math.min(1, Math.abs(poses[i].q.dot(poses[i - 1].q)))));
    d1f.push(Math.abs(poses[i].fov - poses[i - 1].fov));
  }
  for (let i = 1; i < d1p.length; i++) { d2p.push(Math.abs(d1p[i] - d1p[i - 1])); d2a.push(Math.abs(d1a[i] - d1a[i - 1])); }
  const pct = (a, q) => [...a].sort((x, y) => x - y)[Math.floor(a.length * q)];
  const stat = (name, d1, d2, unit, hardMax) => {
    const m1 = Math.max(...d1), m2 = Math.max(...d2), p = pct(d2, 0.995);
    const spike = m2 / Math.max(p, 1e-9);
    const ok = m1 <= hardMax && spike < 12;
    if (!ok) fails.push(`walk ${name}: step max ${m1.toExponential(2)} (limit ${hardMax}), second-difference spike ${spike.toFixed(1)}x`);
    console.log(`  ${name.padEnd(12)} max step ${m1.toExponential(2)} ${unit}/${HW}vh (limit ${hardMax})   max |2nd diff| ${m2.toExponential(2)} = ${spike.toFixed(1)}x p99.5   ${ok ? 'PASS' : 'FAIL'}`);
  };
  console.log(`\nwalk: the blended story camera across Cells ${cellsAt}-${cellsEnd}vh (+-60vh), dive in, walk, rise out; ${n} samples every ${HW}vh:`);
  stat('position', d1p, d2p, 'L', 0.03);          // 0.03 L per 0.1vh = 0.3 L/vh, an order above the real peak (the eased legs)
  stat('orientation', d1a, d2a, 'rad', 0.02);     // 0.02 rad per 0.1vh = 0.2 rad/vh (about 40 degrees per 100px of wheel at the 0.3 walk multiplier)
  // FOV only moves with the weight: monotone up then down, no step
  const fmax = Math.max(...d1f);
  const fok = fmax < 0.2;
  if (!fok) fails.push(`walk fov step ${fmax.toFixed(3)} deg`);
  console.log(`  fov          max step ${fmax.toFixed(3)} deg/${HW}vh (limit 0.2)   ${fok ? 'PASS' : 'FAIL'}`);
  // the weight is 0 at both ends of the sampled range, and the pose there is the plain spline (no residual offset)
  const wEnds = [poses[0].w, poses[n - 1].w];
  const wok = wEnds[0] === 0 && wEnds[1] === 0;
  if (!wok) fails.push(`walk weight at the range ends is ${wEnds}`);
  console.log(`  weight at range ends ${wEnds.join(', ')}   ${wok ? 'PASS' : 'FAIL'}; max weight ${Math.max(...poses.map((p) => p.w)).toFixed(2)}`);
  // no roll pop: the camera's up vector (image up in world space) never changes faster than the orientation limit; and the walker's up is the surface normal at w = 1
  const onGround = poses.filter((p) => p.w === 1);
  const upErr = Math.max(...onGround.map((p) => { const up = new Vector3(0, 1, 0).applyQuaternion(p.q); return 1 - up.dot(p.pos.clone().normalize()); }));
  console.log(`  at full weight the camera's up matches the surface normal: max deviation from 1 = ${upErr.toFixed(3)} (a pitch of ${walkCfg.pitchDeg} deg tips the image up only slightly)`);
}

console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nsmoothness OK: no acceleration spike at the four chapter boundaries (threshold 0.5 x p95 |accel|)');
process.exit(fails.length ? 1 : 0);
