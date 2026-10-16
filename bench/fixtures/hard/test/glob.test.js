const assert = require('assert');
const { match, compile, filter } = require('../src/glob');

let failed = 0;
function t(name, fn) {
  try { fn(); } catch (e) { failed++; console.error('FAIL ' + name + ': ' + String(e.message).split('\n').slice(0, 3).join(' | ')); }
}
function yes(pattern, paths, opts) {
  for (const p of [].concat(paths)) assert.strictEqual(match(pattern, p, opts), true, `${pattern} should match ${p}`);
}
function no(pattern, paths, opts) {
  for (const p of [].concat(paths)) assert.strictEqual(match(pattern, p, opts), false, `${pattern} should not match ${p}`);
}

t('literal patterns match the whole path only', () => {
  yes('src/index.js', 'src/index.js');
  no('src/index.js', ['src/index.jsx', 'xsrc/index.js', 'src/index.j', 'src', 'src/index.js/', 'Src/index.js']);
  yes('', '');
  no('', 'a');
});
t('* stays inside one segment', () => {
  yes('*.js', ['a.js', 'x.y.js', 'index.js']);
  no('*.js', ['src/a.js', 'a.jsx', 'js']);
  yes('src/*', ['src/a', 'src/a.b']);
  no('src/*', ['src', 'src/a/b', 'x/src/a']);
  yes('a*b', ['ab', 'axxb', 'a-b']);
  no('a*b', ['a/b', 'abx']);
  yes('*', ['abc', 'a b']);
  no('*', ['a/b']);
});
t('? matches exactly one non-slash character', () => {
  yes('a?c', ['abc', 'a-c']);
  no('a?c', ['ac', 'abbc', 'a/c']);
  yes('???', ['abc']);
  no('???', ['ab', 'abcd']);
});
t('character classes and ranges', () => {
  yes('[abc].txt', ['a.txt', 'c.txt']);
  no('[abc].txt', ['d.txt', 'ab.txt', '.txt']);
  yes('file[0-9].log', ['file0.log', 'file9.log']);
  no('file[0-9].log', ['filex.log', 'file10.log']);
  yes('[a-cx-z]', ['b', 'y']);
  no('[a-cx-z]', ['d', 'w']);
});
t('negated classes with ! and ^', () => {
  yes('[!a]x', ['bx', '1x']);
  no('[!a]x', ['ax', '/x']);
  yes('[^0-9]', ['a']);
  no('[^0-9]', ['5']);
  no('a[!b]c', 'a/c');
});
t('a class never matches the slash; an unterminated [ is literal', () => {
  no('a[!x]b', 'a/b');
  yes('a[b', 'a[b');
  no('a[b', 'ab');
  yes('[', '[');
});
t('** as a segment matches any number of directories, including none', () => {
  yes('**/a.js', ['a.js', 'x/a.js', 'x/y/z/a.js']);
  no('**/a.js', ['b.js', 'x/b.js', 'x/a.jsx']);
  yes('src/**/test.js', ['src/test.js', 'src/a/test.js', 'src/a/b/c/test.js']);
  no('src/**/test.js', ['test.js', 'lib/a/test.js', 'src/a/test.jsx']);
  yes('a/**/b/**/c', ['a/b/c', 'a/x/b/y/c', 'a/b/b/c']);
});
t('a trailing /** matches everything below but not the directory itself', () => {
  yes('src/**', ['src/a', 'src/a/b', 'src/a/b/c.js']);
  no('src/**', ['src', 'lib/a', 'srcx/a']);
  yes('**', ['a', 'a/b']);
});
t('** inside a longer segment acts like *', () => {
  yes('a**b', ['ab', 'axxb']);
  no('a**b', ['a/b', 'ax/yb']);
  yes('**.js', 'a.js');
  no('**.js', 'x/a.js');
  yes('src/a**', ['src/abc']);
  no('src/a**', ['src/abc/d']);
});
t('brace alternatives', () => {
  yes('*.{js,ts}', ['a.js', 'b.ts']);
  no('*.{js,ts}', ['a.css', 'a.jsx']);
  yes('{src,lib}/**/*.js', ['src/a.js', 'lib/x/y.js']);
  no('{src,lib}/**/*.js', ['test/a.js', 'src/a.ts']);
  yes('{a,b}{1,2}', ['a1', 'a2', 'b1', 'b2']);
  no('{a,b}{1,2}', ['a', 'ab', 'c1']);
});
t('nested and empty alternatives, alternatives containing /', () => {
  yes('x{a,b{c,d}}y', ['xay', 'xbcy', 'xbdy']);
  no('x{a,b{c,d}}y', ['xby', 'xbccy']);
  yes('file{,.bak}', ['file', 'file.bak']);
  no('file{,.bak}', ['file.']);
  yes('{a/b,c}/d', ['a/b/d', 'c/d']);
  no('{a/b,c}/d', ['a/d']);
  yes('{*.js,README}', ['x.js', 'README']);
});
t('unterminated braces are literal; so are lone braces', () => {
  yes('a{b', 'a{b');
  no('a{b', 'ab');
  yes('a}b', 'a}b');
  yes('x{a,b', 'x{a,b');
  yes('{a,b}{c', ['a{c', 'b{c']);
});
t('backslash escapes', () => {
  yes('a\\*b', 'a*b');
  no('a\\*b', ['axb', 'ab']);
  yes('\\[x]', '[x]');
  yes('a\\{b,c\\}', 'a{b,c}');
  no('a\\{b,c\\}', 'ab');
  yes('a\\\\b', 'a\\b');
  yes('\\?', '?');
  no('\\?', 'x');
  yes('[\\]]', ']');
});
t('dotfiles are hidden from wildcards', () => {
  no('*', ['.env', '.git']);
  no('?env', '.env');
  no('[.]env', '.env');
  no('*.js', '.hidden.js');
  no('src/*', 'src/.cache');
  no('**/a.js', ['.git/a.js', 'x/.hidden/a.js']);
  no('**', ['.git', 'a/.b/c', '.x']);
  no('src/**', ['src/.git/config', 'src/a/.b']);
});
t('...but a literal leading dot in the pattern matches them', () => {
  yes('.env', '.env');
  yes('.*', ['.env', '.gitignore']);
  yes('.git/**', ['.git/config', '.git/refs/heads']);
  yes('src/.cache', 'src/.cache');
  yes('**/.env', ['.env', 'a/.env']);
  yes('a/.*/c', 'a/.b/c');
  no('.*', ['env']);
  yes('x*', 'x.y');
  yes('a/*', 'a/b.c');
});
t('opts.dot lifts the dotfile rule', () => {
  yes('*', ['.env'], { dot: true });
  yes('**/a.js', ['.git/a.js', 'x/.hidden/a.js'], { dot: true });
  yes('src/**', ['src/.git/config'], { dot: true });
  yes('?env', '.env', { dot: true });
});
t('opts.nocase', () => {
  yes('*.JS', ['a.js', 'A.Js'], { nocase: true });
  no('*.JS', ['a.js']);
  yes('[a-c]x', ['Bx', 'bx'], { nocase: true });
  yes('SRC/**/Test.js', 'src/a/TEST.JS', { nocase: true });
  no('SRC/**/Test.js', 'src/a/TEST.JS');
});
t('compile() returns a reusable predicate', () => {
  const f = compile('src/**/*.{js,ts}');
  assert.strictEqual(typeof f, 'function');
  assert.deepStrictEqual(['src/a.js', 'src/b/c.ts', 'src/d.css', 'lib/e.js'].map(f), [true, true, false, false]);
  const g = compile('*.md', { nocase: true });
  assert.strictEqual(g('README.MD'), true);
  assert.strictEqual(compile('*.md')('README.MD'), false);
});
t('filter(): positive patterns select', () => {
  const paths = ['a.js', 'b.ts', 'c.css', 'src/d.js'];
  assert.deepStrictEqual(filter(['*.js', '*.ts'], paths), ['a.js', 'b.ts']);
  assert.deepStrictEqual(filter([], paths), []);
  assert.deepStrictEqual(filter(['**'], paths), paths);
});
t('filter(): ! negates and the last matching pattern wins', () => {
  const paths = ['src/a.js', 'src/a.test.js', 'src/b.js', 'docs/readme.md', 'src/vendor/x.js'];
  assert.deepStrictEqual(filter(['src/**', '!**/*.test.js', '!src/vendor/**'], paths), ['src/a.js', 'src/b.js']);
  assert.deepStrictEqual(filter(['!src/**'], paths), []);
  assert.deepStrictEqual(filter(['**/*.js', '!src/**', 'src/b.js'], paths), ['src/b.js']);
  assert.deepStrictEqual(filter(['src/**', '!src/**', 'src/a.js'], paths), ['src/a.js']);
});
t('filter(): passes opts through and keeps the input order, duplicates and all', () => {
  assert.deepStrictEqual(filter(['*.JS'], ['b.js', 'a.js', 'b.js', 'c.ts'], { nocase: true }), ['b.js', 'a.js', 'b.js']);
  assert.deepStrictEqual(filter(['*'], ['.a', 'b'], { dot: true }), ['.a', 'b']);
});
t('realistic ignore list', () => {
  const pats = ['**/node_modules/**', '**/*.{log,tmp}', '!**/keep.log'];
  const f = compile('**/node_modules/**');
  assert.strictEqual(f('a/node_modules/x/y.js'), true);
  assert.strictEqual(f('node_modules/x'), true);
  assert.strictEqual(f('node_modules'), false);
  assert.deepStrictEqual(filter(pats, ['a.log', 'logs/keep.log', 'logs/b.tmp', 'src/a.js', 'node_modules/q/i.js']),
    ['a.log', 'logs/b.tmp', 'node_modules/q/i.js']);
});
t('pathological patterns finish quickly', () => {
  const t0 = Date.now();
  const long = 'a'.repeat(60);
  assert.strictEqual(match('*a*a*a*a*a*a*a*a*b', long), false);
  assert.strictEqual(match('*a*a*a*a*a*a*a*a*', long), true);
  assert.strictEqual(match('**/**/**/**/**/x', 'a/'.repeat(30) + 'y'), false);
  assert.strictEqual(match('**/**/**/**/**/x', 'a/'.repeat(30) + 'x'), true);
  assert.ok(Date.now() - t0 < 1000, 'took ' + (Date.now() - t0) + 'ms');
});
t('segment-wise matching: * does not leak across directories, wildcards do not cross it', () => {
  no('a/*/c', ['a/c', 'a/b/b/c']);
  yes('a/*/c', 'a/b/c');
  no('*/*', ['a']);
  yes('*/*', ['a/b']);
});

if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('glob: all tests passed');
