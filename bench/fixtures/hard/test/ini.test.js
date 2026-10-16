const assert = require('assert');
const { parse, ParseError } = require('../src/ini');

let failed = 0;
function t(name, fn) {
  try { fn(); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + String(e.message).split('\n')[0]); }
}
// assert that parse(text) throws a ParseError at the given 1-based line and column
function err(text, line, column, label) {
  let e;
  try { parse(text); } catch (x) { e = x; }
  assert.ok(e, (label || JSON.stringify(text)) + ': expected a ParseError, nothing was thrown');
  assert.ok(e instanceof ParseError && e instanceof Error, 'not a ParseError: ' + e);
  assert.strictEqual(e.name, 'ParseError');
  assert.deepStrictEqual([e.line, e.column], [line, column], (label || JSON.stringify(text)) + ' -> ' + e.message);
  assert.ok(e.message.endsWith(`at line ${line}, column ${column}`), 'message: ' + e.message);
}

t('empty input', () => {
  assert.deepStrictEqual(parse(''), {});
  assert.deepStrictEqual(parse('\n\n  \n'), {});
});
t('top-level keys and bare strings', () => {
  assert.deepStrictEqual(parse('name = John Smith\nid=x-1'), { name: 'John Smith', id: 'x-1' });
});
t('whitespace around key and value is ignored', () => {
  assert.deepStrictEqual(parse('  \t a_b-c  =   hello world   \n'), { 'a_b-c': 'hello world' });
});
t('comments with # and ;', () => {
  const text = '# first\n; second\n   # indented\na = 1 # trailing\nb = x ; trailing\nc = "a # b" # real comment\n';
  assert.deepStrictEqual(parse(text), { a: 1, b: 'x', c: 'a # b' });
});
t('a bare value stops at the first # or ;', () => {
  assert.deepStrictEqual(parse('u = http://x.org/a#frag'), { u: 'http://x.org/a' });
});
t('booleans', () => {
  assert.deepStrictEqual(parse('a = true\nb = false\nc = True\nd = "true"'), { a: true, b: false, c: 'True', d: 'true' });
});
t('integers and floats', () => {
  assert.deepStrictEqual(parse('a = 42\nb = -7\nc = +3\nd = 3.14\ne = -0.5\nf = 007'),
    { a: 42, b: -7, c: 3, d: 3.14, e: -0.5, f: 7 });
});
t('numeric look-alikes stay strings', () => {
  assert.deepStrictEqual(parse('a = 1.2.3\nb = 12ab\nc = .5\nd = 1e3\ne = 5.'),
    { a: '1.2.3', b: '12ab', c: '.5', d: '1e3', e: '5.' });
});
t('double-quoted strings and escapes', () => {
  assert.deepStrictEqual(parse('a = "x\\ny"\nb = "tab\\there"\nc = "q\\"q"\nd = "back\\\\slash"\ne = "  pad  "\nf = ""'),
    { a: 'x\ny', b: 'tab\there', c: 'q"q', d: 'back\\slash', e: '  pad  ', f: '' });
});
t('single-quoted strings are literal', () => {
  assert.deepStrictEqual(parse("a = 'C:\\new\\table'\nb = 'say \"hi\"'\nc = '#not a comment'"),
    { a: 'C:\\new\\table', b: 'say "hi"', c: '#not a comment' });
});
t('quoted values keep their type as strings', () => {
  assert.deepStrictEqual(parse('a = "42"\nb = \'3.5\''), { a: '42', b: '3.5' });
});
t('sections', () => {
  const text = 'top = 1\n[server]\nhost = localhost\nport = 8080\n[client]\nretries = 3\n';
  assert.deepStrictEqual(parse(text), { top: 1, server: { host: 'localhost', port: 8080 }, client: { retries: 3 } });
});
t('nested sections and whitespace inside headers', () => {
  const text = '[a.b.c]\nx = 1\n[ a . d ]\ny = 2\n   [e]   # note\nz = 3';
  assert.deepStrictEqual(parse(text), { a: { b: { c: { x: 1 } }, d: { y: 2 } }, e: { z: 3 } });
});
t('a parent table created implicitly can be declared later, once', () => {
  assert.deepStrictEqual(parse('[a.b]\nx = 1\n[a]\ny = 2'), { a: { b: { x: 1 }, y: 2 } });
  err('[a.b]\n[a]\n[a]', 3, 1);
});
t('arrays', () => {
  assert.deepStrictEqual(parse('a = [1, 2.5, "x", \'y\', true]\nb = []\nc = [ ]\nd = [1,2,]\ne = [[1, 2], ["a"], []]'),
    { a: [1, 2.5, 'x', 'y', true], b: [], c: [], d: [1, 2], e: [[1, 2], ['a'], []] });
});
t('arrays keep commas and brackets inside strings', () => {
  assert.deepStrictEqual(parse('a = ["x, y", "]", \'[z\'] # c'), { a: ['x, y', ']', '[z'] });
});
t('CRLF line endings and a leading BOM', () => {
  assert.deepStrictEqual(parse('\ufeffa = 1\r\n[s]\r\nb = "two"\r\n'), { a: 1, s: { b: 'two' } });
});
t('no trailing newline needed; last line may be a comment', () => {
  assert.deepStrictEqual(parse('a = 1\n# end'), { a: 1 });
});
t('__proto__ is just a key and never pollutes Object.prototype', () => {
  const r = parse('[__proto__]\npolluted = yes\n[b]\n__proto__ = 5');
  assert.strictEqual(({}).polluted, undefined);
  assert.ok(Object.prototype.hasOwnProperty.call(r, '__proto__'));
  assert.strictEqual(Object.getPrototypeOf(r), Object.prototype);
  assert.strictEqual(Object.getOwnPropertyDescriptor(r, '__proto__').value.polluted, 'yes');
  assert.strictEqual(Object.getOwnPropertyDescriptor(r.b, '__proto__').value, 5);
});

// ---- errors: line and column are 1-based and point at the offending character ----
t('error: duplicate key points at the second key', () => {
  err('a = 1\nb = 2\n  a = 3', 3, 3);
  err('[s]\nk = 1\nk = 2', 3, 1);
});
t('error: the same key in different tables is fine', () => {
  assert.deepStrictEqual(parse('k = 1\n[s]\nk = 2'), { k: 1, s: { k: 2 } });
});
t('error: duplicate section points at its [', () => {
  err('[a]\nx = 1\n  [a]', 3, 3);
});
t('error: a section cannot reuse the name of a plain key', () => {
  err('a = 1\n[a]', 2, 1);
  err('a = 1\n[a.b]', 2, 1);
});
t('error: missing "=" points just after the key (or at the next character)', () => {
  err('a = 1\nfoo', 2, 4);
  err('foo bar = 1', 1, 5);
  err('foo  ', 1, 6);
});
t('error: missing value', () => {
  err('a =', 1, 4);
  err('a =   ', 1, 7);
  err('a = # nothing', 1, 5);
});
t('error: invalid or missing key', () => {
  err('= 1', 1, 1);
  err('ok = 1\n  a$b = 2', 2, 4);
  err('a.b = 1', 1, 2);
});
t('error: unterminated strings point at the opening quote', () => {
  err('a = "abc', 1, 5);
  err("x = 1\nb = 'abc", 2, 5);
  err('a = "abc\\"', 1, 5);
});
t('error: invalid escape points at the backslash', () => {
  err('a = "x\\qy"', 1, 7);
});
t('error: text after a value', () => {
  err('a = "x" y', 1, 9);
  err("a = 'x'z", 1, 8);
  err('a = [1] 2', 1, 9);
});
t('error: arrays', () => {
  err('a = [1, 2', 1, 5);
  err('a = [1 2]', 1, 8);
  err('a = [1, foo]', 1, 9);
  err('a = [1,, 2]', 1, 8);
  err('a = [\n1]', 1, 5);
});
t('error: section headers', () => {
  err('[a', 1, 1);
  err('[]', 1, 2);
  err('[a..b]', 1, 4);
  err('[a.]', 1, 4);
  err('[a b]', 1, 3);
  err('[a] junk', 1, 5);
  err('x = 1\n\n  [ok]\n[bad name]', 4, 5);
});
t('error: line numbers count blank, comment and CRLF lines', () => {
  err('# c\r\n\r\n; c\r\na = 1\r\na = 2\r\n', 5, 1);
});

if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('ini: all tests passed');
