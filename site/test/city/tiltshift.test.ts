// Plain node asserts: `node site/test/city/tiltshift.test.ts` from the repo root.
// Tilt-shift has no WebGL in node, so this checks structure only: the real run
// still loads through buildLayout/buildTimeline, the timeline sweep stays
// finite and deterministic, and a fake pass host records exactly two passes
// (horizontal then vertical) with the focus-band uniforms, enabled toggling,
// resolution updates and an idempotent dispose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildLayout } from '../../src/lib/city/lots.ts';
import { buildTimeline } from '../../src/lib/city/timeline.ts';
import { createTiltShift } from '../../src/lib/city/tiltshift.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));

function noNaN(v: unknown, path = 'state'): void {
  if (typeof v === 'number') assert.ok(Number.isFinite(v), `${path} is not finite`);
  else if (Array.isArray(v)) v.forEach((x, i) => noNaN(x, `${path}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noNaN(x, `${path}.${k}`);
}

interface TestUniform {
  value: any;
}

interface TestPass {
  enabled: boolean;
  uniforms: Record<string, TestUniform>;
  material: {
    uniforms: Record<string, TestUniform>;
    fragmentShader: string;
    dispose(): void;
  };
}

interface FakeHost {
  passes: unknown[];
  removed: unknown[];
  addPass(pass: unknown): void;
  removePass(pass: unknown): void;
}

// The real run drives the layout and the timeline; tilt-shift itself is a
// scroll-independent post effect, so the sweep just pins the engine side.
const layout = buildLayout(run);
assert.ok(layout.lots.length > 0, 'real run has lots');
const timeline = buildTimeline(run);
for (let i = 0; i <= 200; i++) {
  const s = timeline.stateAt(i / 200);
  noNaN(s, `stateAt(${i / 200})`);
}
// Same scroll position, same state: scrolling back rewinds exactly.
for (const u of [0, 0.137, 0.5, 0.863, 1]) assert.deepEqual(timeline.stateAt(u), timeline.stateAt(u));

const tilt = createTiltShift();
const host: FakeHost = {
  passes: [],
  removed: [],
  addPass(pass: unknown): void {
    host.passes.push(pass);
  },
  removePass(pass: unknown): void {
    host.removed.push(pass);
  },
};
tilt.install(host);
assert.equal(host.passes.length, 2, 'install adds exactly two passes');
const [hPass, vPass] = host.passes as unknown as [TestPass, TestPass];

// Horizontal blur first, then vertical.
const hDir = hPass.uniforms['direction'].value;
const vDir = vPass.uniforms['direction'].value;
assert.equal(hDir.x, 1);
assert.equal(hDir.y, 0);
assert.equal(vDir.x, 0);
assert.equal(vDir.y, 1);

for (const [name, pass] of [['h', hPass], ['v', vPass]] as const) {
  const u = pass.uniforms;
  for (const key of ['tDiffuse', 'direction', 'resolution', 'focusCenter', 'focusHalfWidth', 'maxRadius']) {
    assert.ok(key in u, `${name} pass has uniform ${key}`);
  }
  assert.equal(u['focusCenter'].value, 0.5);
  assert.equal(u['focusHalfWidth'].value, 0.22);
  assert.ok(Math.abs(u['maxRadius'].value - 2.5) < 1e-9, `${name} max blur radius is about 2.5 px`);
  assert.ok(Number.isFinite(u['resolution'].value.x) && Number.isFinite(u['resolution'].value.y));
  assert.ok(Number.isFinite(u['direction'].value.x) && Number.isFinite(u['direction'].value.y));
  assert.equal(pass.enabled, true);
  // Strength rises smoothly away from the band, sampling the prior pass.
  assert.ok(pass.material.fragmentShader.includes('smoothstep'), `${name} shader fades strength smoothly`);
  assert.ok(pass.material.fragmentShader.includes('tDiffuse'), `${name} shader samples tDiffuse`);
}
// Same focus band, different blur axis.
assert.equal(hPass.material.fragmentShader, vPass.material.fragmentShader);

// Enabled toggling skips the effect entirely.
tilt.setEnabled(false);
assert.equal(hPass.enabled, false);
assert.equal(vPass.enabled, false);
tilt.setEnabled(true);
assert.equal(hPass.enabled, true);
assert.equal(vPass.enabled, true);

// Resolution uniforms track the drawing buffer on both passes.
tilt.setSize(800, 600);
assert.deepEqual([hPass.uniforms['resolution'].value.x, hPass.uniforms['resolution'].value.y], [800, 600]);
assert.deepEqual([vPass.uniforms['resolution'].value.x, vPass.uniforms['resolution'].value.y], [800, 600]);
tilt.setSize(1280, 720);
assert.deepEqual([hPass.uniforms['resolution'].value.x, hPass.uniforms['resolution'].value.y], [1280, 720]);
assert.deepEqual([vPass.uniforms['resolution'].value.x, vPass.uniforms['resolution'].value.y], [1280, 720]);

// Dispose frees both materials and unregisters both passes, and is safe twice.
let hDisposed = 0;
let vDisposed = 0;
const hDispose = hPass.material.dispose.bind(hPass.material);
const vDispose = vPass.material.dispose.bind(vPass.material);
hPass.material.dispose = () => {
  hDisposed++;
  hDispose();
};
vPass.material.dispose = () => {
  vDisposed++;
  vDispose();
};
tilt.dispose();
assert.deepEqual(host.removed, host.passes, 'dispose removes both passes');
assert.equal(hDisposed, 1);
assert.equal(vDisposed, 1);
tilt.dispose();
assert.equal(host.removed.length, 2, 'second dispose removes nothing more');
assert.equal(hDisposed, 1);
assert.equal(vDisposed, 1);

console.log('tiltshift.test.ts: ok');
