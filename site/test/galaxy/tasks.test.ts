import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELPER, OPUS_WHAT, TASK_WHAT, fixerWhat } from '../../src/lib/galaxy/tasks.ts';
import type { FeaturedRun } from '../../src/lib/run.ts';

function loadReal(): FeaturedRun {
  const candidates = [
    resolve(process.cwd(), 'public/data/featured-run.json'),
    resolve(process.cwd(), 'site/public/data/featured-run.json'),
  ];
  for (const f of candidates) {
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as FeaturedRun;
    } catch {
      // try next
    }
  }
  throw new Error('featured-run.json not found from ' + process.cwd());
}

const run = loadReal();

// Every worker slug on the page has a what-line.
for (const w of run.workers) {
  assert.ok(TASK_WHAT[w.slug], `${w.slug} has a TASK_WHAT entry`);
}

// HELPER covers every lane the run uses (run.lanes and every worker's lane).
const lanes = new Set([...run.lanes, ...run.workers.map((w) => w.lane)]);
for (const lane of lanes) {
  assert.ok(HELPER[lane], `HELPER covers lane ${lane}`);
}

// Every TASK_WHAT key is a module of the "scaffold" fixture in bench/cases.json:
// find the object that has key "scaffold", wherever it sits in the JSON.
const cases = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../bench/cases.json'), 'utf8'),
) as unknown;
function findScaffold(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) {
    for (const item of v) {
      const found = findScaffold(item);
      if (found) return found;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (obj.scaffold && typeof obj.scaffold === 'object' && !Array.isArray(obj.scaffold)) return obj;
    for (const child of Object.values(obj)) {
      const found = findScaffold(child);
      if (found) return found;
    }
  }
  return null;
}
const fixtures = findScaffold(cases);
assert.ok(fixtures, 'cases.json contains a "scaffold" fixture');
const scaffold = fixtures!.scaffold as Record<string, unknown>;
for (const key of Object.keys(TASK_WHAT)) {
  assert.ok(typeof scaffold[`src/${key}.js`] === 'string', `scaffold fixture has src/${key}.js for ${key}`);
}

// Smallest units: the fixer phrase and the Opus line.
assert.equal(fixerWhat('cron'), "fixes cron's failing tests");
assert.equal(OPUS_WHAT, 'plans, reviews, merges');
