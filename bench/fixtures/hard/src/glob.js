/*
 * glob.js - match "/"-separated paths against shell-style glob patterns.
 *
 *   const { match, compile, filter } = require('./glob');
 *   match(pattern, path, opts) -> boolean
 *   compile(pattern, opts)     -> (path) => boolean       (same semantics, parse once, test many)
 *   filter(patterns, paths, opts) -> the paths that are selected, in their original order
 *
 * Pattern syntax (a path is matched as a whole, case-sensitively by default):
 *   *        any run of characters inside one path segment (never matches "/")
 *   ?        exactly one character, not "/"
 *   **       as a complete segment, zero or more whole segments: `a/**` + `/b` matches `a/b` and
 *            `a/x/y/b`; `**` + `/x` also matches plain `x`; a trailing `/**` matches everything
 *            below the directory but not the directory itself. Inside a longer segment (`a**b`)
 *            it just acts like `*`.
 *   [abc] [a-z] [!abc] [^abc]    one character from / not from the set (ranges allowed)
 *   {a,b,c}  alternatives; they may be nested, contain "/", or be empty (`x{,.bak}`)
 *   \x       the character x, literally (so `\*` is a star and `\{` a brace)
 * An unterminated `[` or `{` is an ordinary character. A character class never matches "/".
 *
 * Dotfiles: a path segment that starts with "." is only matched by a pattern segment that itself
 * starts with a literal "." - never by `*`, `?`, `[...]` or `**` - unless opts.dot is true.
 * opts.nocase makes letters match regardless of case.
 *
 * filter(): `patterns` is a list evaluated in order, gitignore style. A path starts out not
 * selected; each pattern that matches it selects it, or unselects it when the pattern begins with "!"
 * (the rest is the glob). The last matching pattern wins.
 *
 * Matching must stay fast on awkward input such as `*a*a*a*a*a*a*b` against a long run of "a"s.
 * See test/glob.test.js for the exact expectations.
 */
function match(pattern, path, opts) {
  throw new Error('TODO: implement match');
}

function compile(pattern, opts) {
  throw new Error('TODO: implement compile');
}

function filter(patterns, paths, opts) {
  throw new Error('TODO: implement filter');
}

module.exports = { match, compile, filter };
