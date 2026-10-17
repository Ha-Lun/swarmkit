class ParseError extends Error {
  constructor(msg, line, column) {
    super(`${msg} at line ${line}, column ${column}`);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

function put(obj, key, val) {
  Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const KEY = /^[A-Za-z0-9_-]$/;

function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const root = {};
  let cur = root;
  const explicit = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const L = idx + 1;
    const fail = (msg, col) => { throw new ParseError(msg, L, col); };
    let i = 0;
    const ws = () => { while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++; };
    ws();
    if (i >= line.length || line[i] === '#' || line[i] === ';') return;
    const restOk = () => {
      ws();
      if (i < line.length && line[i] !== '#' && line[i] !== ';') fail('unexpected text after value', i + 1);
    };

    if (line[i] === '[') {
      const open = i + 1;
      const close = line.indexOf(']', i);
      if (close < 0) fail('unterminated section header', open);
      const inner = line.slice(i + 1, close);
      const names = [];
      let off = i + 1;
      for (const seg of inner.split('.')) {
        const lead = seg.length - seg.trimStart().length;
        const name = seg.trim();
        if (!name) fail('empty section name', off + lead + 1);
        for (let k = 0; k < name.length; k++) {
          if (!KEY.test(name[k])) fail(`invalid character '${name[k]}' in section name`, off + lead + k + 1);
        }
        names.push(name);
        off += seg.length + 1;
      }
      i = close + 1;
      restOk();
      const full = names.join('.');
      if (explicit.has(full)) fail('duplicate section', open);
      explicit.add(full);
      let t = root;
      for (const n of names) {
        if (!has(t, n)) put(t, n, {});
        else if (!isObj(t[n])) fail(`section conflicts with key '${n}'`, open);
        t = t[n];
      }
      cur = t;
      return;
    }

    const kstart = i;
    while (i < line.length && KEY.test(line[i])) i++;
    const key = line.slice(kstart, i);
    if (!key) fail(`invalid key character '${line[i]}'`, i + 1);
    const kend = i;
    ws();
    if (line[i] !== '=') fail("expected '='", i < line.length && kend === i ? i + 1 : i + 1);
    i++;
    ws();
    if (i >= line.length || line[i] === '#' || line[i] === ';') fail('missing value', i + 1);
    const val = value();
    restOk();
    if (has(cur, key)) fail('duplicate key', kstart + 1);
    put(cur, key, val);

    function value() {
      const c = line[i];
      if (c === '"') return dq();
      if (c === "'") {
        const e = line.indexOf("'", i + 1);
        if (e < 0) fail('unterminated string', i + 1);
        const s = line.slice(i + 1, e);
        i = e + 1;
        return s;
      }
      if (c === '[') return arr();
      let e = i;
      while (e < line.length && line[e] !== '#' && line[e] !== ';') e++;
      const tok = line.slice(i, e).trim();
      i = e;
      return bare(tok);
    }
    function bare(tok) {
      if (tok === 'true') return true;
      if (tok === 'false') return false;
      if (/^[+-]?\d+$/.test(tok)) return parseInt(tok, 10);
      if (/^[+-]?\d+\.\d+$/.test(tok)) return parseFloat(tok);
      return tok;
    }
    function dq() {
      const start = i;
      i++;
      let s = '';
      for (;;) {
        if (i >= line.length) fail('unterminated string', start + 1);
        const c = line[i];
        if (c === '"') { i++; return s; }
        if (c === '\\') {
          const n = line[i + 1];
          const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
          if (!has(map, n || '')) fail(`invalid escape '\\${n || ''}'`, i + 1);
          s += map[n];
          i += 2;
        } else { s += c; i++; }
      }
    }
    function arr() {
      const start = i;
      i++;
      const out = [];
      for (;;) {
        ws();
        if (i >= line.length) fail('unterminated array', start + 1);
        if (line[i] === ']') { i++; return out; }
        const c = line[i];
        let v;
        if (c === '"') v = dq();
        else if (c === "'") {
          const e = line.indexOf("'", i + 1);
          if (e < 0) fail('unterminated string', i + 1);
          v = line.slice(i + 1, e);
          i = e + 1;
        } else if (c === '[') v = arr();
        else {
          let e = i;
          while (e < line.length && !/[,\]\s#;]/.test(line[e])) e++;
          const tok = line.slice(i, e);
          const b = bare(tok);
          if (typeof b === 'string') fail(`invalid array element '${tok}'`, i + 1);
          v = b;
          i = e;
        }
        out.push(v);
        ws();
        if (line[i] === ',') { i++; continue; }
        if (line[i] === ']') { i++; return out; }
        if (i >= line.length) fail('unterminated array', start + 1);
        fail("expected ',' or ']' in array", i + 1);
      }
    }
  });
  return root;
}

module.exports = { parse, ParseError };
