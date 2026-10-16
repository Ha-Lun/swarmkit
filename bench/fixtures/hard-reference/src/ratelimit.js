function num(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return v;
}
function checkCost(cost) {
  if (!Number.isInteger(cost) || cost <= 0) throw new RangeError('cost must be a positive integer');
}

class Base {
  constructor(now) {
    this._now = now || Date.now;
    this._keys = new Map();
  }
  get size() { return this._keys.size; }
  reset(key) {
    if (arguments.length === 0) this._keys.clear();
    else this._keys.delete(key);
  }
  peek(key) { return { remaining: this._peek(key) }; }
}

class TokenBucket extends Base {
  constructor({ capacity, refillPerSec, now } = {}) {
    super(now);
    this.capacity = num(capacity, 'capacity');
    this.refillPerSec = num(refillPerSec, 'refillPerSec');
  }
  _state(key) {
    const t = this._now();
    let s = this._keys.get(key);
    if (!s) { s = { tokens: this.capacity, last: t }; this._keys.set(key, s); return s; }
    const dt = Math.max(0, t - s.last);
    s.tokens = Math.min(this.capacity, s.tokens + (dt * this.refillPerSec) / 1000);
    s.last = t;
    return s;
  }
  check(key, cost = 1) {
    checkCost(cost);
    const s = this._state(key);
    if (cost <= s.tokens) {
      s.tokens -= cost;
      return { allowed: true, remaining: Math.floor(s.tokens), retryAfterMs: 0 };
    }
    const retry = cost > this.capacity ? Infinity : Math.ceil(((cost - s.tokens) / this.refillPerSec) * 1000 - 1e-9);
    return { allowed: false, remaining: Math.floor(s.tokens), retryAfterMs: retry };
  }
  _peek(key) {
    if (!this._keys.has(key)) return Math.floor(this.capacity);
    return Math.floor(this._state(key).tokens);
  }
}

class SlidingWindow extends Base {
  constructor({ limit, windowMs, now } = {}) {
    super(now);
    this.limit = num(limit, 'limit');
    this.windowMs = num(windowMs, 'windowMs');
  }
  _log(key) {
    const t = this._now();
    let s = this._keys.get(key);
    if (!s) { s = { log: [], last: t }; this._keys.set(key, s); }
    if (t < s.last) { // clock went backwards: pretend no time passed
      const shift = s.last - t;
      for (const e of s.log) e.t -= shift;
    }
    s.last = t;
    while (s.log.length && t - s.log[0].t >= this.windowMs) s.log.shift();
    return { s, t, used: s.log.reduce((n, e) => n + e.cost, 0) };
  }
  check(key, cost = 1) {
    checkCost(cost);
    const { s, t, used } = this._log(key);
    if (used + cost <= this.limit) {
      s.log.push({ t, cost });
      return { allowed: true, remaining: Math.floor(this.limit - used - cost), retryAfterMs: 0 };
    }
    let retry = Infinity;
    if (cost <= this.limit) {
      let freed = this.limit - used;
      for (const e of s.log) {
        freed += e.cost;
        if (freed >= cost) { retry = e.t + this.windowMs - t; break; }
      }
    }
    return { allowed: false, remaining: Math.floor(this.limit - used), retryAfterMs: Math.ceil(retry) };
  }
  _peek(key) {
    if (!this._keys.has(key)) return Math.floor(this.limit);
    const { used } = this._log(key);
    return Math.floor(this.limit - used);
  }
}

module.exports = { TokenBucket, SlidingWindow };
