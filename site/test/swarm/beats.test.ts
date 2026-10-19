// Plain node asserts: `node --test test/swarm/` from site/. The 8-beat scroll map:
// equal contiguous ranges tiling [0, 1], hold-then-morph timing, clamping.
import assert from 'node:assert/strict';
import { BEATS, beatAt } from '../../src/lib/swarm/beats.ts';

// --- Table shape: 8 beats, equal 1/8 ranges, contiguous, ordered, in contract order.
assert.equal(BEATS.length, 8);
assert.deepEqual(
  BEATS.map((b) => [b.id, b.formation]),
  [
    ['hero', 'disk'],
    ['plan', 'lattice'],
    ['fanout', 'streams'],
    ['build', 'towers'],
    ['merge', 'hex'],
    ['numbers', 'ring'],
    ['clis', 'trio'],
    ['cta', 'disk'],
  ],
);
for (let i = 0; i < BEATS.length; i++) {
  assert.equal(BEATS[i].start, i / 8, `beat ${i} start`);
  assert.equal(BEATS[i].end, (i + 1) / 8, `beat ${i} end`);
  assert.ok(BEATS[i].end - BEATS[i].start === 1 / 8, `beat ${i} equal share`);
  if (i > 0) assert.equal(BEATS[i].start, BEATS[i - 1].end, 'contiguous');
}
assert.equal(BEATS[0].start, 0);
assert.equal(BEATS[BEATS.length - 1].end, 1);

// --- beatAt(0) = hero, mix 0.
const s0 = beatAt(0);
assert.deepEqual(s0, { index: 0, beat: 'hero', local: 0, from: 'disk', to: 'lattice', mix: 0 });

// --- Hold: just inside the hero beat the mix is still 0; just below the
// hold/morph boundary (local 0.5) it is exactly 0.
assert.equal(beatAt(0.06).mix, 0);
assert.equal(beatAt(0.0625 - 1e-9).mix, 0);
const hold = beatAt(0.0625 + 1e-9);
assert.equal(hold.beat, 'hero');
assert.ok(hold.mix < 1e-6, `hold mix ~0, got ${hold.mix}`);

// --- Morph: just below 0.25 the plan beat is almost fully morphed into streams.
const pre = beatAt(0.25 - 1e-7);
assert.equal(pre.beat, 'plan');
assert.equal(pre.from, 'lattice');
assert.equal(pre.to, 'streams');
assert.ok(pre.mix > 0.999 && pre.mix <= 1, `mix near 1, got ${pre.mix}`);

// --- Mid-morph value: local 0.75 -> smoothstep(0.5) = 0.5 exactly.
assert.equal(beatAt(0.09375).mix, 0.5);

// --- beatAt(1) = cta, mix 0, self-loop.
assert.deepEqual(beatAt(1), { index: 7, beat: 'cta', local: 1, from: 'disk', to: 'disk', mix: 0 });

// --- Clamping.
assert.deepEqual(beatAt(-1), beatAt(0));
assert.deepEqual(beatAt(2), beatAt(1));

// --- Beat boundaries open the next beat at local 0.
for (let i = 1; i < 8; i++) {
  const s = beatAt(i / 8);
  assert.equal(s.index, i);
  assert.equal(s.local, 0);
  assert.equal(s.mix, 0);
}

// --- Mix is monotonic within every morphing beat, 0 through the hold half,
// and always 0 on the last beat.
for (let b = 0; b < 7; b++) {
  let prev = -1;
  for (let k = 0; k <= 19; k++) {
    const s = beatAt((b + k / 20) / 8);
    assert.equal(s.index, b);
    if (k <= 10) assert.equal(s.mix, 0, `beat ${b} hold at local ${k / 20}`);
    assert.ok(s.mix >= prev, `beat ${b} mix monotonic at local ${k / 20}`);
    assert.ok(s.mix >= 0 && s.mix <= 1, 'mix in range');
    prev = s.mix;
  }
  // Local 1 morphs fully into the next beat's formation.
  const end = beatAt((b + 1) / 8 - 1e-9);
  assert.equal(end.index, b);
  assert.ok(end.mix > 0.999 && end.mix <= 1, `beat ${b} mix reaches 1`);
}
for (let k = 0; k <= 20; k++) assert.equal(beatAt((7 + k / 20) / 8).mix, 0, 'cta never morphs');

console.log('beats.test.ts: ok');
