/*
 * merge3.js - three-way text merge, in the spirit of `git merge-file` / diff3.
 *
 *   const { merge3 } = require('./merge3');
 *   merge3(base, ours, theirs, opts) -> { text, conflicts }
 *
 * `base` is the common ancestor; `ours` and `theirs` are two edited versions of it. All three are
 * strings and are compared line by line. The result combines both sets of edits:
 *   - Edits to different parts of the text are all applied.
 *   - If both sides made the very same edit, it is applied once and is not a conflict.
 *   - If the two sides edited the same lines differently, or edited lines that touch each other
 *     (no unchanged base line in between, insertions at the same spot included), the result holds a
 *     conflict region with git-style markers instead:
 *
 *         <<<<<<< ours
 *         (our lines)
 *         =======
 *         (their lines)
 *         >>>>>>> theirs
 *
 *     With opts.diff3 the region also shows the base lines, between our lines and `=======`,
 *     introduced by a `||||||| base` line. Labels come from opts.oursLabel, opts.theirsLabel and
 *     opts.baseLabel (defaults 'ours', 'theirs', 'base'); markers are always 7 characters long.
 *   - `conflicts` is the number of conflict regions in `text`. Nothing is ever dropped silently.
 *
 * Lines keep their line terminators, so a final line without a newline differs from the same line
 * with one, and "\r\n" files merge as they are. A marker always starts on a fresh line: if the last
 * line of one side of a conflict has no terminator, "\n" is added to it inside the region.
 * The inputs are never modified. See test/merge3.test.js for the exact expectations.
 */
function merge3(base, ours, theirs, opts) {
  throw new Error('TODO: implement merge3');
}

module.exports = { merge3 };
