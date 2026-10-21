// What each helper on the galaxy page built and which kind of helper ran it.
// Descriptions summarise the module contracts in bench/cases.json (fixture "scaffold"); keep them factual.
import type { Lane } from '../run.ts';

/** Worker lanes as they read in a sentence. */
export const HELPER: Record<Lane, string> = {
  opencode: 'OpenCode worker',
  agy: 'Antigravity worker',
};

/** One short present-tense phrase per module of the "scaffold" fixture in bench/cases.json. */
export const TASK_WHAT: Record<string, string> = {
  csv: 'parses and writes CSV',
  semver: 'parses, compares and range-checks versions',
  lru: 'a least-recently-used cache',
  expr: 'evaluates maths expressions',
  cron: 'parses cron schedules, finds the next run',
  template: 'renders {{ }} templates with HTML escaping',
  diff: 'diffs lines and applies patches',
  wrap: 'wraps text to a width',
};

/** What a fixer branch did, named after the worker whose failing tests it fixed. */
export function fixerWhat(target: string): string {
  return `fixes ${target}'s failing tests`;
}

/** What Opus itself did on the run. */
export const OPUS_WHAT = 'plans, reviews, merges';
