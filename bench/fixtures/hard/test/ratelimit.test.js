const assert = require('assert');
const { TokenBucket, SlidingWindow } = require('../src/ratelimit');

let failed = 0;
function t(name, fn) {
  try { fn(); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 4).join(' | ')); }
}
const R = (allowed, remaining, retryAfterMs) => ({ allowed, remaining, retryAfterMs });
function clock(start = 0) {
  const c = { t: start, now: () => c.t, set(v) { c.t = v; }, tick(ms) { c.t += ms; } };
  return c;
}

// ---------------- TokenBucket ----------------
t('bucket: starts full and drains', () => {
  const c = clock(1000);
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: c.now });
  assert.deepStrictEqual(b.check('k'), R(true, 2, 0));
  assert.deepStrictEqual(b.check('k'), R(true, 1, 0));
  assert.deepStrictEqual(b.check('k'), R(true, 0, 0));
  assert.deepStrictEqual(b.check('k'), R(false, 0, 1000));
});
t('bucket: refills continuously and tokens accumulate fractionally', () => {
  const c = clock();
  const b = new TokenBucket({ capacity: 4, refillPerSec: 2, now: c.now });
  b.check('k', 4);
  c.tick(250); // 0.5 token
  assert.deepStrictEqual(b.check('k'), R(false, 0, 250));
  c.tick(250); // 1.0 token in total
  assert.deepStrictEqual(b.check('k'), R(true, 0, 0));
  c.tick(1750); // 3.5 tokens
  assert.deepStrictEqual(b.peek('k'), { remaining: 3 });
  c.tick(250); // 4.0
  assert.deepStrictEqual(b.peek('k'), { remaining: 4 });
});
t('bucket: never refills beyond capacity', () => {
  const c = clock();
  const b = new TokenBucket({ capacity: 2, refillPerSec: 10, now: c.now });
  b.check('k', 2);
  c.tick(60 * 60 * 1000);
  assert.deepStrictEqual(b.check('k', 2), R(true, 0, 0));
  assert.deepStrictEqual(b.check('k'), R(false, 0, 100));
});
t('bucket: retryAfterMs is rounded up to a whole millisecond', () => {
  const c = clock();
  const b = new TokenBucket({ capacity: 5, refillPerSec: 3, now: c.now });
  b.check('k', 5);
  assert.deepStrictEqual(b.check('k'), R(false, 0, 334));
  c.tick(334);
  assert.deepStrictEqual(b.check('k'), R(true, 0, 0));
});
t('bucket: cost greater than one', () => {
  const c = clock();
  const b = new TokenBucket({ capacity: 10, refillPerSec: 5, now: c.now });
  assert.deepStrictEqual(b.check('k', 7), R(true, 3, 0));
  assert.deepStrictEqual(b.check('k', 5), R(false, 3, 400));
  assert.deepStrictEqual(b.peek('k'), { remaining: 3 }); // the denied check spent nothing
  c.tick(400);
  assert.deepStrictEqual(b.check('k', 5), R(true, 0, 0));
});
t('bucket: cost above capacity can never succeed', () => {
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clock().now });
  assert.deepStrictEqual(b.check('k', 4), R(false, 3, Infinity));
  assert.deepStrictEqual(b.check('k', 3), R(true, 0, 0));
});
t('bucket: keys are independent', () => {
  const c = clock();
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1, now: c.now });
  assert.strictEqual(b.check('a').allowed, true);
  assert.strictEqual(b.check('a').allowed, false);
  assert.strictEqual(b.check('b').allowed, true);
  assert.strictEqual(b.size, 2);
});
t('bucket: peek spends nothing and does not create keys', () => {
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clock().now });
  assert.deepStrictEqual(b.peek('new'), { remaining: 3 });
  assert.strictEqual(b.size, 0);
  b.check('x');
  assert.deepStrictEqual(b.peek('x'), { remaining: 2 });
  assert.deepStrictEqual(b.peek('x'), { remaining: 2 });
  assert.strictEqual(b.size, 1);
});
t('bucket: reset one key or all keys', () => {
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: clock().now });
  b.check('a', 2);
  b.check('b', 2);
  assert.strictEqual(b.size, 2);
  b.reset('a');
  assert.strictEqual(b.size, 1);
  assert.deepStrictEqual(b.check('a'), R(true, 1, 0));
  assert.strictEqual(b.check('b').allowed, false);
  b.reset();
  assert.strictEqual(b.size, 0);
  assert.deepStrictEqual(b.check('b', 2), R(true, 0, 0));
});
t('bucket: a clock that moves backwards grants nothing, and time resumes from the earlier point', () => {
  const c = clock(1000);
  const b = new TokenBucket({ capacity: 2, refillPerSec: 1, now: c.now });
  b.check('k', 2);
  c.set(500);
  assert.deepStrictEqual(b.check('k'), R(false, 0, 1000));
  c.set(1500); // one second after the step back
  assert.deepStrictEqual(b.check('k'), R(true, 0, 0));
});
t('bucket: default clock is Date.now', () => {
  const b = new TokenBucket({ capacity: 1, refillPerSec: 1 });
  assert.strictEqual(b.check('k').allowed, true);
  assert.strictEqual(b.check('k').allowed, false);
});
t('bucket: bad options and bad costs', () => {
  for (const bad of [{}, { capacity: 0, refillPerSec: 1 }, { capacity: 1, refillPerSec: 0 }, { capacity: -1, refillPerSec: 1 },
    { capacity: NaN, refillPerSec: 1 }, { capacity: 1, refillPerSec: Infinity }, { capacity: '3', refillPerSec: 1 }]) {
    assert.throws(() => new TokenBucket(bad), RangeError, JSON.stringify(bad));
  }
  const b = new TokenBucket({ capacity: 3, refillPerSec: 1, now: clock().now });
  for (const cost of [0, -1, 1.5, NaN, '1', null]) assert.throws(() => b.check('k', cost), RangeError, String(cost));
  assert.strictEqual(b.size, 0); // a rejected call leaves no trace
});

// ---------------- SlidingWindow ----------------
t('window: allows limit units per window', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 3, windowMs: 1000, now: c.now });
  assert.deepStrictEqual(w.check('k'), R(true, 2, 0));
  c.tick(100);
  assert.deepStrictEqual(w.check('k'), R(true, 1, 0));
  c.tick(100);
  assert.deepStrictEqual(w.check('k'), R(true, 0, 0));
  c.tick(100); // t = 300
  assert.deepStrictEqual(w.check('k'), R(false, 0, 700));
});
t('window: a unit stops counting at exactly t + windowMs', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 1, windowMs: 1000, now: c.now });
  w.check('k');
  c.set(999);
  assert.deepStrictEqual(w.check('k'), R(false, 0, 1));
  c.set(1000);
  assert.deepStrictEqual(w.check('k'), R(true, 0, 0));
});
t('window: it slides, there are no fixed buckets', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 2, windowMs: 1000, now: c.now });
  c.set(900); w.check('k');
  c.set(950); w.check('k');
  c.set(1000); // a fixed window starting at 0 would have reset here
  assert.deepStrictEqual(w.check('k'), R(false, 0, 900));
  c.set(1899);
  assert.deepStrictEqual(w.check('k'), R(false, 0, 1));
  c.set(1900);
  assert.deepStrictEqual(w.check('k'), R(true, 0, 0)); // the unit from 900 is gone, 950 and 1900 count
  c.set(1950);
  assert.deepStrictEqual(w.peek('k'), { remaining: 1 }); // 950 has expired too
});
t('window: retryAfterMs waits for enough units to expire when cost > 1', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 5, windowMs: 1000, now: c.now });
  w.check('k', 2);          // t = 0
  c.set(300); w.check('k', 2);
  c.set(600); w.check('k', 1);
  assert.deepStrictEqual(w.check('k', 1), R(false, 0, 400));  // the first two units free up at 1000
  assert.deepStrictEqual(w.check('k', 3), R(false, 0, 700));  // 2 units free at 1000, 4 at 1300
  assert.deepStrictEqual(w.check('k', 4), R(false, 0, 700));
  assert.deepStrictEqual(w.check('k', 5), R(false, 0, 1000)); // everything has expired at 1600
});
t('window: denied checks are not recorded', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 1, windowMs: 1000, now: c.now });
  w.check('k');
  c.set(500); assert.strictEqual(w.check('k').allowed, false);
  c.set(900); assert.strictEqual(w.check('k').allowed, false);
  c.set(1000); assert.strictEqual(w.check('k').allowed, true);
});
t('window: cost above the limit can never succeed', () => {
  const w = new SlidingWindow({ limit: 3, windowMs: 1000, now: clock().now });
  assert.deepStrictEqual(w.check('k', 4), R(false, 3, Infinity));
  assert.deepStrictEqual(w.check('k', 3), R(true, 0, 0));
});
t('window: keys are independent; peek, reset and size', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 2, windowMs: 1000, now: c.now });
  assert.deepStrictEqual(w.peek('a'), { remaining: 2 });
  assert.strictEqual(w.size, 0);
  w.check('a'); w.check('a'); w.check('b');
  assert.strictEqual(w.size, 2);
  assert.deepStrictEqual(w.peek('a'), { remaining: 0 });
  assert.deepStrictEqual(w.peek('b'), { remaining: 1 });
  w.reset('a');
  assert.deepStrictEqual(w.check('a'), R(true, 1, 0));
  w.reset();
  assert.strictEqual(w.size, 0);
});
t('window: a clock that moves backwards counts as no time passed', () => {
  const c = clock(1000);
  const w = new SlidingWindow({ limit: 1, windowMs: 1000, now: c.now });
  w.check('k');                       // spent at 1000
  c.set(200);                         // jump back 800ms: still "just spent"
  assert.deepStrictEqual(w.check('k'), R(false, 0, 1000));
  c.set(1199);
  assert.deepStrictEqual(w.check('k'), R(false, 0, 1));
  c.set(1200);
  assert.deepStrictEqual(w.check('k'), R(true, 0, 0));
});
t('window: many events stay correct (and quick)', () => {
  const c = clock();
  const w = new SlidingWindow({ limit: 100, windowMs: 1000, now: c.now });
  let allowed = 0;
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) { c.set(i * 5); if (w.check('k').allowed) allowed++; }
  // 200 events are offered per window and 100 may pass: 20000 events over 100s allow about 100 per second
  assert.ok(allowed >= 9900 && allowed <= 10100, 'allowed = ' + allowed);
  assert.ok(Date.now() - t0 < 1500, 'too slow');
});
t('window: bad options and bad costs', () => {
  for (const bad of [{}, { limit: 0, windowMs: 1 }, { limit: 1, windowMs: 0 }, { limit: 1, windowMs: -5 }, { limit: Infinity, windowMs: 1 }]) {
    assert.throws(() => new SlidingWindow(bad), RangeError, JSON.stringify(bad));
  }
  const w = new SlidingWindow({ limit: 3, windowMs: 1000, now: clock().now });
  for (const cost of [0, -2, 0.5, NaN]) assert.throws(() => w.check('k', cost), RangeError, String(cost));
});
t('both limiters share one interface', () => {
  for (const L of [new TokenBucket({ capacity: 2, refillPerSec: 1 }), new SlidingWindow({ limit: 2, windowMs: 1000 })]) {
    for (const m of ['check', 'peek', 'reset']) assert.strictEqual(typeof L[m], 'function', m);
    assert.strictEqual(L.size, 0);
    const r = L.check('x');
    assert.deepStrictEqual(Object.keys(r).sort(), ['allowed', 'remaining', 'retryAfterMs']);
  }
});

if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('ratelimit: all tests passed');
