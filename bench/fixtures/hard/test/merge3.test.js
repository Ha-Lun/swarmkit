const assert = require('assert');
const { merge3 } = require('../src/merge3');

let failed = 0;
function t(name, fn) {
  try { fn(); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 6).join(' | ')); }
}
const L = (...ls) => ls.join('\n') + '\n'; // lines joined with a trailing newline
function same(base, ours, theirs, text, conflicts, opts) {
  assert.deepStrictEqual(merge3(base, ours, theirs, opts), { text, conflicts });
}

t('nothing changed', () => {
  const b = L('a', 'b', 'c');
  same(b, b, b, b, 0);
});
t('only ours changed', () => {
  same(L('a', 'b', 'c'), L('a', 'B', 'c'), L('a', 'b', 'c'), L('a', 'B', 'c'), 0);
});
t('only theirs changed', () => {
  same(L('a', 'b', 'c'), L('a', 'b', 'c'), L('a', 'b', 'C', 'd'), L('a', 'b', 'C', 'd'), 0);
});
t('edits in different places are both applied', () => {
  const base = L('1', '2', '3', '4', '5', '6', '7');
  const ours = L('1', 'two', '3', '4', '5', '6', '7');
  const theirs = L('1', '2', '3', '4', '5', 'six', '7');
  same(base, ours, theirs, L('1', 'two', '3', '4', '5', 'six', '7'), 0);
});
t('insertions and deletions in different places', () => {
  const base = L('a', 'b', 'c', 'd', 'e');
  const ours = L('x', 'a', 'b', 'c', 'd', 'e');       // insert at the top
  const theirs = L('a', 'b', 'c', 'e');               // delete d
  same(base, ours, theirs, L('x', 'a', 'b', 'c', 'e'), 0);
});
t('an unchanged line between two edits keeps them apart', () => {
  const base = L('a', 'b', 'c');
  same(base, L('A', 'b', 'c'), L('a', 'b', 'C'), L('A', 'b', 'C'), 0);
});
t('identical edits on both sides apply once', () => {
  const base = L('a', 'b', 'c');
  const both = L('a', 'B', 'c');
  same(base, both, both, both, 0);
});
t('identical edits plus a different edit elsewhere', () => {
  const base = L('1', '2', '3', '4', '5');
  same(base, L('1', 'X', '3', '4', '5'), L('1', 'X', '3', '4', 'Y'), L('1', 'X', '3', '4', 'Y'), 0);
});
t('both delete the same line', () => {
  const base = L('a', 'b', 'c');
  same(base, L('a', 'c'), L('a', 'c'), L('a', 'c'), 0);
});
t('a simple conflict', () => {
  const base = L('a', 'b', 'c');
  const text = L('a', '<<<<<<< ours', 'B1', '=======', 'B2', '>>>>>>> theirs', 'c');
  same(base, L('a', 'B1', 'c'), L('a', 'B2', 'c'), text, 1);
});
t('custom labels', () => {
  const text = L('<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> feature/z');
  same('o\n', 'x\n', 'y\n', text, 1, { oursLabel: 'HEAD', theirsLabel: 'feature/z' });
});
t('diff3 style shows the base lines', () => {
  const base = L('a', 'b', 'c');
  const text = L('a', '<<<<<<< ours', 'B1', '||||||| base', 'b', '=======', 'B2', '>>>>>>> theirs', 'c');
  same(base, L('a', 'B1', 'c'), L('a', 'B2', 'c'), text, 1, { diff3: true });
  const text2 = L('a', '<<<<<<< A', 'B1', '||||||| O', 'b', '=======', 'B2', '>>>>>>> B', 'c');
  same(base, L('a', 'B1', 'c'), L('a', 'B2', 'c'), text2, 1, { diff3: true, oursLabel: 'A', baseLabel: 'O', theirsLabel: 'B' });
});
t('diff3 does not change clean merges', () => {
  same(L('a', 'b', 'c'), L('A', 'b', 'c'), L('a', 'b', 'C'), L('A', 'b', 'C'), 0, { diff3: true });
});
t('edit versus delete of the same line conflicts', () => {
  const base = L('a', 'b', 'c');
  same(base, L('a', 'B', 'c'), L('a', 'c'), L('a', '<<<<<<< ours', 'B', '=======', '>>>>>>> theirs', 'c'), 1);
  same(base, L('a', 'c'), L('a', 'B', 'c'), L('a', '<<<<<<< ours', '=======', 'B', '>>>>>>> theirs', 'c'), 1);
});
t('insertions at the same place conflict unless identical', () => {
  const base = L('a', 'c');
  same(base, L('a', 'x', 'c'), L('a', 'y', 'c'), L('a', '<<<<<<< ours', 'x', '=======', 'y', '>>>>>>> theirs', 'c'), 1);
  same(base, L('a', 'x', 'c'), L('a', 'x', 'c'), L('a', 'x', 'c'), 0);
});
t('edits that touch each other conflict', () => {
  const base = L('a', 'b', 'c', 'd');
  // ours changes b, theirs changes c: no unchanged line between them
  const text = L('a', '<<<<<<< ours', 'B', 'c', '=======', 'b', 'C', '>>>>>>> theirs', 'd');
  same(base, L('a', 'B', 'c', 'd'), L('a', 'b', 'C', 'd'), text, 1);
});
t('an insertion right next to a changed line conflicts', () => {
  const base = L('a', 'b', 'c');
  const text = L('a', '<<<<<<< ours', 'new', 'b', '=======', 'B', '>>>>>>> theirs', 'c');
  same(base, L('a', 'new', 'b', 'c'), L('a', 'B', 'c'), text, 1);
});
t('overlapping multi-line edits form one conflict', () => {
  const base = L('1', '2', '3', '4', '5', '6');
  const ours = L('1', 'a', 'b', 'c', '5', '6');         // replaces 2-4
  const theirs = L('1', '2', 'x', 'y', 'z', '6');       // replaces 3-5
  const text = L('1', '<<<<<<< ours', 'a', 'b', 'c', '5', '=======', '2', 'x', 'y', 'z', '>>>>>>> theirs', '6');
  same(base, ours, theirs, text, 1);
});
t('one conflict can swallow several small edits of the other side', () => {
  const base = L('1', '2', '3', '4', '5', '6', '7');
  const ours = L('1', 'X', '3', '4', '5', 'Y', '7');    // two separate edits
  const theirs = L('1', 'T', 'T', 'T', 'T', 'T', '7');  // one big edit covering both
  const text = L('1', '<<<<<<< ours', 'X', '3', '4', '5', 'Y', '=======', 'T', 'T', 'T', 'T', 'T', '>>>>>>> theirs', '7');
  same(base, ours, theirs, text, 1);
});
t('two separate conflicts are counted separately', () => {
  const base = L('a', 'b', 'c', 'd', 'e');
  const ours = L('A1', 'b', 'c', 'd', 'E1');
  const theirs = L('A2', 'b', 'c', 'd', 'E2');
  const text = L('<<<<<<< ours', 'A1', '=======', 'A2', '>>>>>>> theirs', 'b', 'c', 'd',
    '<<<<<<< ours', 'E1', '=======', 'E2', '>>>>>>> theirs');
  same(base, ours, theirs, text, 2);
});
t('a conflict and a clean change in the same merge', () => {
  const base = L('a', 'b', 'c', 'd', 'e');
  const ours = L('a', 'B1', 'c', 'd', 'e');
  const theirs = L('a', 'B2', 'c', 'D', 'e');
  const text = L('a', '<<<<<<< ours', 'B1', '=======', 'B2', '>>>>>>> theirs', 'c', 'D', 'e');
  same(base, ours, theirs, text, 1);
});
t('repeated lines are matched in order', () => {
  const base = L('a', '}', 'b', '}');
  same(base, L('a', '}', 'B', '}'), L('a', '}', 'b', '}', 'end'), L('a', '}', 'B', '}', 'end'), 0);
});
t('empty inputs', () => {
  same('', '', '', '', 0);
  same('', 'new\n', '', 'new\n', 0);
  same('', 'same\n', 'same\n', 'same\n', 0);
  same('', 'x\n', 'y\n', L('<<<<<<< ours', 'x', '=======', 'y', '>>>>>>> theirs'), 1);
  same('a\n', '', 'a\n', '', 0);
  same('a\n', '', '', '', 0);
});
t('both sides add the same text to an empty base, ours also adds more', () => {
  same('', 'a\n', 'a\nb\n', L('<<<<<<< ours', 'a', '=======', 'a', 'b', '>>>>>>> theirs'), 1);
});
t('missing final newline is a real difference', () => {
  same('a\nb', 'a\nb', 'a\nb\n', 'a\nb\n', 0);
  same('a\nb\n', 'a\nb', 'a\nb', 'a\nb', 0);
  same('a\nb', 'a\nB', 'a\nb\n', 'a\n<<<<<<< ours\nB\n=======\nb\n>>>>>>> theirs\n', 1);
});
t('a conflict with unterminated last lines still puts markers on their own lines', () => {
  same('x', 'y', 'z', '<<<<<<< ours\ny\n=======\nz\n>>>>>>> theirs\n', 1);
});
t('CRLF text', () => {
  const base = 'a\r\nb\r\nc\r\n';
  same(base, 'A\r\nb\r\nc\r\n', 'a\r\nb\r\nC\r\n', 'A\r\nb\r\nC\r\n', 0);
});
t('inputs are strings that are not modified; results are fresh plain objects', () => {
  const r = merge3('a\n', 'b\n', 'a\n');
  assert.deepStrictEqual(Object.keys(r).sort(), ['conflicts', 'text']);
  assert.strictEqual(typeof r.text, 'string');
  const opts = Object.freeze({ diff3: true });
  assert.strictEqual(merge3('a\n', 'b\n', 'c\n', opts).conflicts, 1);
});
t('larger realistic merge', () => {
  const base = L('function f(a, b) {', '  const s = a + b;', '  log(s);', '  return s;', '}', '', 'module.exports = f;');
  const ours = L('function f(a, b) {', '  const s = a + b;', '  log(s);', '  return s;', '}', '', 'function g() {}', '', 'module.exports = f;');
  const theirs = L('// adds numbers', 'function f(a, b) {', '  const s = Number(a) + Number(b);', '  log(s);', '  return s;', '}', '', 'module.exports = f;');
  const want = L('// adds numbers', 'function f(a, b) {', '  const s = Number(a) + Number(b);', '  log(s);', '  return s;', '}', '', 'function g() {}', '', 'module.exports = f;');
  same(base, ours, theirs, want, 0);
});

if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('merge3: all tests passed');
