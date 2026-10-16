// Expand {a,b} alternatives (nested, escapes respected). Unterminated braces stay literal.
function expand(p) {
  let depth = 0, start = -1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      const inner = p.slice(start + 1, i);
      const parts = [];
      let d = 0, last = 0;
      for (let k = 0; k < inner.length; k++) {
        const ch = inner[k];
        if (ch === '\\') { k++; continue; }
        if (ch === '{') d++;
        else if (ch === '}') d--;
        else if (ch === ',' && d === 0) { parts.push(inner.slice(last, k)); last = k + 1; }
      }
      parts.push(inner.slice(last));
      const head = p.slice(0, start), tail = p.slice(i + 1);
      const out = [];
      for (const part of parts) for (const e of expand(head + part + tail)) out.push(e);
      return out;
    }
  }
  if (depth > 0) { // unterminated: treat the first unmatched "{" as a literal
    const k = p.indexOf('{', 0);
    const rest = expand(p.slice(k + 1));
    return rest.map((r) => p.slice(0, k) + '\\{' + r);
  }
  return [p];
}

function splitSegments(p) {
  const segs = [];
  let cur = '';
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) { cur += p[i] + p[i + 1]; i++; }
    else if (p[i] === '/') { segs.push(cur); cur = ''; }
    else cur += p[i];
  }
  segs.push(cur);
  return segs;
}

// tokens: {lit} | {any} | {star} | {set, neg, items:[[lo,hi]]}
function tokens(seg) {
  const out = [];
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\' && i + 1 < seg.length) out.push({ lit: seg[++i] });
    else if (c === '*') { if (!out.length || !out[out.length - 1].star) out.push({ star: true }); }
    else if (c === '?') out.push({ any: true });
    else if (c === '[') {
      let j = i + 1, neg = false;
      if (seg[j] === '!' || seg[j] === '^') { neg = true; j++; }
      const items = [];
      let first = true, closed = false;
      for (; j < seg.length; j++) {
        let ch = seg[j];
        if (ch === ']' && !first) { closed = true; break; }
        first = false;
        if (ch === '\\' && j + 1 < seg.length) ch = seg[++j];
        if (seg[j + 1] === '-' && seg[j + 2] !== undefined && seg[j + 2] !== ']') {
          let hi = seg[j + 2];
          j += 2;
          if (hi === '\\' && j + 1 < seg.length) hi = seg[++j];
          items.push([ch, hi]);
        } else items.push([ch, ch]);
      }
      if (closed) { out.push({ set: true, neg, items }); i = j; } else out.push({ lit: '[' });
    } else out.push({ lit: c });
  }
  return out;
}

function segMatcher(seg, opts) {
  const toks = tokens(seg);
  const nocase = !!opts.nocase;
  const eq = (a, b) => (nocase ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inSet = (t, ch) => {
    let hit = t.items.some(([lo, hi]) => (ch >= lo && ch <= hi) ||
      (nocase && ((ch.toLowerCase() >= lo.toLowerCase() && ch.toLowerCase() <= hi.toLowerCase()) ||
        (ch.toUpperCase() >= lo.toUpperCase() && ch.toUpperCase() <= hi.toUpperCase()))));
    return hit !== t.neg;
  };
  const one = (t, ch) => (t.lit !== undefined ? eq(t.lit, ch) : t.any ? true : inSet(t, ch));
  const startsDot = toks.length > 0 && toks[0].lit === '.';
  return (s) => {
    if (!opts.dot && s[0] === '.' && !startsDot) return false;
    let ti = 0, si = 0, starT = -1, starS = 0;
    while (si < s.length) {
      if (ti < toks.length && toks[ti].star) { starT = ti++; starS = si; }
      else if (ti < toks.length && one(toks[ti], s[si])) { ti++; si++; }
      else if (starT >= 0) { ti = starT + 1; si = ++starS; }
      else return false;
    }
    while (ti < toks.length && toks[ti].star) ti++;
    return ti === toks.length;
  };
}

function compileOne(pattern, opts) {
  const segs = splitSegments(pattern).map((s) => (s === '**' ? { globstar: true } : { m: segMatcher(s, opts) }));
  return (path) => {
    const parts = path.split('/');
    const memo = new Map();
    const go = (pi, si) => {
      const key = pi * (parts.length + 1) + si;
      if (memo.has(key)) return memo.get(key);
      let r;
      if (pi === segs.length) r = si === parts.length;
      else if (segs[pi].globstar) {
        r = false;
        if (pi === segs.length - 1) { // trailing "/**": everything below, at least one segment
          r = si < parts.length && parts.slice(si).every((p) => opts.dot || p[0] !== '.');
        } else {
          for (let k = si; k <= parts.length && !r; k++) {
            if (k > si && !opts.dot && parts[k - 1][0] === '.') break;
            r = go(pi + 1, k);
          }
        }
      } else r = si < parts.length && segs[pi].m(parts[si]) && go(pi + 1, si + 1);
      memo.set(key, r);
      return r;
    };
    return go(0, 0);
  };
}

function compile(pattern, opts = {}) {
  const fns = expand(pattern).map((p) => compileOne(p, opts));
  return (path) => fns.some((f) => f(path));
}
const match = (pattern, path, opts) => compile(pattern, opts)(path);

function filter(patterns, paths, opts = {}) {
  const rules = patterns.map((p) => (p[0] === '!' ? { neg: true, f: compile(p.slice(1), opts) } : { neg: false, f: compile(p, opts) }));
  return paths.filter((path) => {
    let sel = false;
    for (const r of rules) if (r.f(path)) sel = !r.neg;
    return sel;
  });
}

module.exports = { match, compile, filter };
