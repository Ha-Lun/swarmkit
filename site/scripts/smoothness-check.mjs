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
    contents: "export { loadAgents } from './src/lib/agents.ts'; export * as cam from './src/lib/world/camera-path.ts'; export { layoutLattice } from './src/lib/world/honeycomb.ts'; export { motion, walkWeight, walkCfg, walkRamp, loopT, loopCamera, LOOP_VH } from './src/lib/world/motion-config.ts'; export { loopCameraPose } from './src/lib/world/loop.ts'; export { walkCameraPose, walkBlendBase } from './src/lib/world/walk.ts'; export { examples, gates } from './src/content/routing.ts'; export { createFollowRoute } from './src/lib/world/follow.ts'; export { journeysOf, walkStopsOf } from './src/lib/journeys.ts'; export { Vector3, Quaternion } from 'three';",
    resolveDir: resolve('.'), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
});
const { loadAgents, cam, layoutLattice, motion, walkWeight, walkCfg, walkRamp, loopT, loopCamera, LOOP_VH, loopCameraPose, createFollowRoute, walkCameraPose, walkBlendBase, examples, gates, journeysOf, walkStopsOf, Vector3, Quaternion } = await import(pathToFileURL(out).href);
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
const coreName = lattice.cells.find((c) => !c.moon && c.agent?.band === 'core').agent.name;
for (const jn of journeysOf(examples, gates.map((g) => g.agent))) {
  const route = createFollowRoute(lattice, walkStopsOf(jn, coreName, walkCfg.coreSec));
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
    poses.push({ S, w, pos, q, fov, cp: dp.chapterProgress });
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
  // (a route that mostly holds still has a tiny p99.5 of second differences, so any real move reads as a spike: the ratio test also passes under an absolute ceiling `abs2`, the largest second difference accepted on the 27-stop tour)
  const stat = (name, d1, d2, unit, hardMax, abs2 = 0) => {
    const m1 = Math.max(...d1), m2 = Math.max(...d2), p = pct(d2, 0.995);
    const spike = m2 / Math.max(p, 1e-9);
    const ok = m1 <= hardMax && (spike < 12 || m2 < abs2);
    if (!ok) fails.push(`walk (${jn.tier}) ${name}: step max ${m1.toExponential(2)} (limit ${hardMax}), second-difference spike ${spike.toFixed(1)}x`);
    console.log(`  ${name.padEnd(12)} max step ${m1.toExponential(2)} ${unit}/${HW}vh (limit ${hardMax})   max |2nd diff| ${m2.toExponential(2)} = ${spike.toFixed(1)}x p99.5   ${ok ? 'PASS' : 'FAIL'}`);
  };
  console.log(`\nwalk (${jn.task}, ${jn.tier}: ${route.stops.length} stops): the blended story camera across Cells ${cellsAt}-${cellsEnd}vh (+-60vh), dive in, walk, rise out; ${n} samples every ${HW}vh:`);
  stat('position', d1p, d2p, 'L', 0.03, 5e-3);          // 0.03 L per 0.1vh = 0.3 L/vh, an order above the real peak (the eased legs)
  // The route runs by itself at walkCfg.rate (autoplay), so inside it the limits are angular speeds in time, converted to per-0.1vh at that pace; the dive and the rise are scroll-driven
  // (the wheel, or autoplay at its brisker pace) and keep the per-scroll limits: 0.02 rad per 0.1vh = 0.2 rad/vh (about 40 degrees per 100px of wheel at the 0.3 walk multiplier).
  const routeSec = route.length / walkCfg.rate, vhPerSec = ((cellsEnd - cellsAt) * (walkCfg.uTo - walkCfg.uFrom)) / routeSec;
  const per01vh = (perSec) => (perSec * HW) / vhPerSec;
  const i0 = poses.findIndex((p) => p.cp >= walkCfg.uFrom && p.w > 0), i1 = poses.length - 1 - [...poses].reverse().findIndex((p) => p.cp <= walkCfg.uTo && p.w > 0);
  const sliceMax = (name, a, b, d1, unit, max) => { if (b - a < 4) return; const m = Math.max(...d1.slice(a, b)), ok = m <= max; if (!ok) fails.push(`walk (${jn.tier}) ${name}: step max ${m.toExponential(2)} (limit ${max})`); console.log(`  ${name.padEnd(12)} max step ${m.toExponential(2)} ${unit}/${HW}vh (limit ${max.toFixed(4)})   ${ok ? 'PASS' : 'FAIL'}`); };
  if (i0 < 0 || i1 >= poses.length || i1 <= i0) { fails.push('walk: no samples on the route'); }
  const degMax = 140, fovMax = 20;
  console.log(`  (route: ${route.length.toFixed(0)} route units = ${routeSec.toFixed(0)} s at ${walkCfg.rate}/s, ${vhPerSec.toFixed(1)} vh/s; turns limited to ${degMax} deg/s = ${per01vh((degMax * Math.PI) / 180).toFixed(4)} rad/${HW}vh)`);
  stat('orientation', d1a, d2a, 'rad', Infinity, 4e-3); // (the spike test over the whole journey; the step limits follow per part)
  { const k = d2a.indexOf(Math.max(...d2a)) + 1, q = poses[k]; console.log(`    (largest orientation 2nd difference at ${q.S.toFixed(1)}vh, Cells progress ${q.cp.toFixed(4)}, walk weight ${q.w.toFixed(3)})`); }
  sliceMax('orient dive', 0, i0, d1a, 'rad', 0.02);
  sliceMax('orient route', i0, i1, d1a, 'rad', per01vh((degMax * Math.PI) / 180));
  sliceMax('orient rise', i1, d1a.length, d1a, 'rad', 0.02);
  const fovStat = (name, a, b, max) => { if (b - a < 4) return; const m = Math.max(...d1f.slice(a, b)), ok = m < max; if (!ok) fails.push(`walk fov ${name} step ${m.toFixed(3)} deg`); console.log(`  fov ${name.padEnd(8)} max step ${m.toFixed(3)} deg/${HW}vh (limit ${max.toFixed(3)})   ${ok ? 'PASS' : 'FAIL'}`); };
  fovStat('dive', 0, i0, 0.2); fovStat('route', i0, i1, per01vh(fovMax)); fovStat('rise', i1, d1f.length, 0.2);
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

// ---- the loop: the finale's homecoming ends on the intro's rest pose, so the wrap of the scroll (end -> start) cannot be seen ----
// The camera path sits at its end (g = 1) over the whole homecoming; the world blends it back to sample(SEGMENTS[0].t1), the pose the intro holds, with loopCamera(b) (world.ts pose()).
{
  const rest = new Vector3(), restT = new Vector3(), a = new Vector3(), aT = new Vector3();
  path.sample(cam.SEGMENTS[0].t1, rest, restT);
  const span = motion.runway.finale - 40, HL = 0.1; // the last trigger spans runway - 40vh
  const n = Math.round(LOOP_VH / HL), poses = [];
  for (let i = 0; i <= n; i++) {
    const pf = 1 - (LOOP_VH - i * HL) / span; // finale chapterProgress
    const g = cam.scrollToProgress(4, pf);
    path.sample(g, a, aT);
    const w = loopCamera(loopT(pf));
    loopCameraPose(a, aT, rest, restT, w);
    poses.push({ pos: a.clone().divideScalar(L), tgt: aT.clone().divideScalar(L), g, w });
  }
  const end = poses[n];
  const seam = end.pos.distanceTo(rest.clone().divideScalar(L)) + end.tgt.distanceTo(restT.clone().divideScalar(L));
  const steps = poses.slice(1).map((p, i) => p.pos.distanceTo(poses[i].pos));
  const smax = Math.max(...steps), lastStep = steps[steps.length - 1];
  const minR = Math.min(...poses.map((p) => p.pos.length()));
  const gOk = poses.every((p) => Math.abs(p.g - 1) < 1e-9);
  const checks = [
    [`finale end pose = intro rest pose (distance ${seam.toExponential(1)} L)`, seam < 1e-9],
    [`camera path holds its end over the homecoming (g = 1 throughout)`, gOk],
    [`position max step ${smax.toExponential(2)} L/${HL}vh (limit 0.03)`, smax < 0.03],
    [`flat at the seam: last step ${lastStep.toExponential(1)} L < 2% of the max`, lastStep < 0.02 * smax],
    [`never closer to the globe than ${minR.toFixed(2)} L (> 3)`, minR > 3],
  ];
  console.log(`\nloop: the finale homecoming (${LOOP_VH}vh) back to the intro's rest pose, ${n + 1} samples:`);
  for (const [label, ok] of checks) { if (!ok) fails.push(`loop: ${label}`); console.log(`  ${label}   ${ok ? 'PASS' : 'FAIL'}`); }
}

console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nsmoothness OK: no acceleration spike at the four chapter boundaries (threshold 0.5 x p95 |accel|)');
process.exit(fails.length ? 1 : 0);
