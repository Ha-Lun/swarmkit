/*
 * ratelimit.js - per-key rate limiters with an injectable clock.
 *
 *   const { TokenBucket, SlidingWindow } = require('./ratelimit');
 *
 *   new TokenBucket({ capacity, refillPerSec, now })
 *   new SlidingWindow({ limit, windowMs, now })
 *
 * `now` is an optional function returning the current time in milliseconds (default Date.now);
 * tests drive it by hand. Both classes track every key separately and share this interface:
 *
 *   limiter.check(key, cost = 1) -> { allowed, remaining, retryAfterMs }
 *       Try to spend `cost` units for `key`. If allowed, the units are spent. A denied check spends
 *       nothing. `remaining` is how many whole units are still available after the check.
 *       `retryAfterMs` is 0 when allowed; otherwise the smallest whole number of milliseconds to
 *       wait until a check of the same cost would be allowed (Infinity if it never could be,
 *       because cost exceeds the capacity or limit).
 *   limiter.peek(key) -> { remaining }       Same figure as above, without spending anything.
 *   limiter.reset(key)                       Forget one key (it starts afresh). reset() with no
 *                                            argument forgets all keys.
 *   limiter.size                             Number of keys currently remembered.
 *
 * TokenBucket: a bucket starts full (capacity tokens) and refills continuously at refillPerSec,
 * never beyond capacity; fractions of a token accumulate. SlidingWindow: at most `limit` units may be
 * spent in any window of `windowMs`; a unit spent at time t stops counting at exactly t + windowMs.
 *
 * Bad constructor options (non-positive or non-finite numbers) throw RangeError; a `cost` that is not
 * a positive integer throws RangeError too. If the clock moves backwards, treat it as no time having
 * passed and carry on from the new, earlier time. Details the above leaves open are pinned down by
 * test/ratelimit.test.js.
 */
class TokenBucket {
  constructor(opts) {
    throw new Error('TODO: implement TokenBucket');
  }
}

class SlidingWindow {
  constructor(opts) {
    throw new Error('TODO: implement SlidingWindow');
  }
}

module.exports = { TokenBucket, SlidingWindow };
