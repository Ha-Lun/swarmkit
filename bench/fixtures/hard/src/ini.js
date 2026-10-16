/*
 * ini.js - parser for a small TOML-like configuration format.
 *
 *   const { parse, ParseError } = require('./ini');
 *   parse(text) -> plain object
 *
 * The format, roughly:
 *   - `key = value` lines, `[section]` headers, and `[a.b]` for nested sections.
 *     Keys before the first header belong to the top-level object.
 *   - Blank lines are ignored. A line whose first non-blank character is `#` or `;` is a comment.
 *     A comment may also follow a value on the same line.
 *   - Values: double-quoted strings (with \n \t \r \" \\ escapes), single-quoted strings (literal,
 *     no escapes), true/false, integers, floats, single-line arrays of those (nesting allowed,
 *     trailing comma allowed), and otherwise a bare string (trimmed).
 *   - Whitespace around keys, `=`, section names and array elements is insignificant.
 *   - Each key may be defined once per table and each section once; a second definition is an error.
 *     A parent table that only exists because `[a.b]` was seen may still be declared later with `[a]`.
 *   - A leading BOM and CRLF line endings are accepted.
 *
 * Mistakes are reported by throwing ParseError (a subclass of Error). It carries `line` and
 * `column`, both 1-based, pointing at the offending character, and its message ends with
 * `at line L, column C`. See test/ini.test.js for exactly where each kind of error points
 * and for the details this header leaves open.
 */
class ParseError extends Error {}

function parse(text) {
  throw new Error('TODO: implement parse');
}

module.exports = { parse, ParseError };
