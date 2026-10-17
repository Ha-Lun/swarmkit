function lines(text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

// LCS-based hunks turning a into b: { start, end, lines } meaning a[start..end) is replaced by lines
function hunks(a, b) {
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0, si = 0, sj = 0;
  const flush = (ei, ej) => {
    if (ei > si || ej > sj) out.push({ start: si, end: ei, lines: b.slice(sj, ej) });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush(i, j);
      i++; j++; si = i; sj = j;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  flush(n, m);
  return out;
}

function apply(baseLines, hs, lo, hi) {
  const out = [];
  let pos = lo;
  for (const h of hs) {
    out.push(...baseLines.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...baseLines.slice(pos, hi));
  return out;
}

function merge3(base, ours, theirs, opts = {}) {
  const { oursLabel = 'ours', theirsLabel = 'theirs', baseLabel = 'base', diff3 = false } = opts;
  const B = lines(base);
  const A = hunks(B, lines(ours));
  const T = hunks(B, lines(theirs));
  const out = [];
  let conflicts = 0, pos = 0, i = 0, j = 0;
  const nl = (ls) => ls.length && !ls[ls.length - 1].endsWith('\n') ? [...ls.slice(0, -1), ls[ls.length - 1] + '\n'] : ls;
  const take = (h) => { out.push(...B.slice(pos, h.start), ...h.lines); pos = h.end; };

  while (i < A.length || j < T.length) {
    const a = A[i], b = T[j];
    if (a && (!b || a.end < b.start)) { take(a); i++; continue; }
    if (b && (!a || b.end < a.start)) { take(b); j++; continue; }
    // touching or overlapping: grow a cluster over both sides
    let lo = Math.min(a.start, b.start), hi = Math.max(a.end, b.end);
    const ca = [a], cb = [b];
    i++; j++;
    for (let grew = true; grew;) {
      grew = false;
      while (i < A.length && A[i].start <= hi) { ca.push(A[i]); hi = Math.max(hi, A[i].end); i++; grew = true; }
      while (j < T.length && T[j].start <= hi) { cb.push(T[j]); hi = Math.max(hi, T[j].end); j++; grew = true; }
    }
    out.push(...B.slice(pos, lo));
    pos = hi;
    const mine = apply(B, ca, lo, hi), theirs_ = apply(B, cb, lo, hi);
    if (mine.length === theirs_.length && mine.every((l, k) => l === theirs_[k])) out.push(...mine);
    else {
      conflicts++;
      out.push(`<<<<<<< ${oursLabel}\n`, ...nl(mine));
      if (diff3) out.push(`||||||| ${baseLabel}\n`, ...nl(B.slice(lo, hi)));
      out.push('=======\n', ...nl(theirs_), `>>>>>>> ${theirsLabel}\n`);
    }
  }
  out.push(...B.slice(pos));
  return { text: out.join(''), conflicts };
}

module.exports = { merge3 };
