// Plain node asserts: `node --test site/test/city/terminal.test.ts` from the worktree root. The terminal
// replay panel lines built from public/data/featured-run.json: prompt first, dispatch/merge per worker,
// self-check wording (never "failed"), visibility windows, sort order, the final cost/duration line, chapters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTerminalLines, CHAPTERS, chapterFor, stamp, visibleLines } from '../../src/lib/city/terminal.ts';
import { formatDuration } from '../../src/lib/city/captions.ts';
import { BEAT_IDS } from '../../src/lib/city/types.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

const run: FeaturedRun = JSON.parse(readFileSync(new URL('../../public/data/featured-run.json', import.meta.url), 'utf8'));
const lines = buildTerminalLines(run);

// The first two lines are the prompt.
assert.equal(lines[0].kind, 'prompt');
assert.equal(lines[0].text, '[00:00] $ claude --agent lead-dev-hybrid');
assert.equal(lines[1].kind, 'prompt');
assert.equal(lines[1].text, `[00:00] > ${run.task}`);

// A dispatch line and a merge line for a known slug from featured-run.json.
const dispatchExpr = lines.find((l) => l.kind === 'dispatch' && l.slug === 'expr');
assert.ok(dispatchExpr, 'dispatch line for expr');
assert.equal(dispatchExpr.text, '[00:20] ▸ opencode · expr started');
const mergeExpr = lines.find((l) => l.kind === 'merge' && l.slug === 'expr');
assert.ok(mergeExpr, 'merge line for expr');
assert.ok(mergeExpr.text.endsWith('⇢ merged · expr'), `merge text: ${mergeExpr.text}`);

// A not-ok worker with denied commands reads "self-check flagged", never "failed".
const deniedWorker = run.workers.find((w) => !w.ok && w.denied_count > 0)!;
assert.ok(deniedWorker, 'featured run has a not-ok worker with denied commands');
const deniedLine = lines.find((l) => l.kind === 'done' && l.slug === deniedWorker.slug);
assert.ok(deniedLine, `done line for ${deniedWorker.slug}`);
assert.match(deniedLine.text, /self-check flagged/);
assert.match(deniedLine.text, new RegExp(`${deniedWorker.denied_count} command\\(s\\) denied`));
assert.ok(!/failed/i.test(deniedLine.text), `no "failed" for a self-check: ${deniedLine.text}`);
for (const l of lines.filter((l) => l.kind === 'done')) {
  assert.ok(!/failed/i.test(l.text), `no "failed" in any self-check line: ${l.text}`);
}

// visibleLines at t=0 returns only the t=0 lines; at Infinity, all of them.
const atZero = visibleLines(lines, 0);
assert.ok(atZero.length > 0, 't=0 shows the prompt');
assert.ok(atZero.every((l) => l.t === 0), 'only t=0 lines at t=0');
assert.equal(atZero.length, lines.filter((l) => l.t === 0).length);
assert.deepEqual(visibleLines(lines, Infinity), lines);

// Lines are sorted by (t, order).
for (let i = 1; i < lines.length; i++) {
  const a = lines[i - 1], b = lines[i];
  assert.ok(b.t > a.t || (b.t === a.t && b.order >= a.order), `sorted at index ${i}`);
}

// The final line has the cost and duration.
const last = lines[lines.length - 1];
assert.equal(last.kind, 'final');
assert.ok(last.text.includes(`$${run.cost_usd.toFixed(2)}`), `cost in final line: ${last.text}`);
assert.ok(last.text.includes(formatDuration(run.wall_s)), `duration in final line: ${last.text}`);

// chapterFor maps every BeatId.
assert.deepEqual(
  BEAT_IDS.map((b) => [b, chapterFor(b)]),
  [['hero', 1], ['task', 1], ['plan', 2], ['lanes', 3], ['verify', 4], ['merge', 4], ['review', 4], ['bill', 5]],
);
assert.equal(CHAPTERS[1].title, 'You ask');
assert.equal(CHAPTERS[5].line, 'One real run, start to finish.');

// stamp(83) === '[01:23]'.
assert.equal(stamp(83), '[01:23]');

console.log('terminal: ok');
