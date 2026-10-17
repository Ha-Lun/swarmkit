// Captions for the City stage, one short line per beat, built from the run at build time. Pure (tests in
// test/city/scene-logic.test.ts). Every number comes from the run; wording rules from STATUS.md and the README:
// first merges come before the cross-model review; the review leads to a small annex pass; plan approval is said to
// be automatic when it was; a self-check ok:false is "command denied", never failed code; a fixer branch finished
// the worker that needed one; reviews carry no verdict; tokens only where they were recorded, as quota, never USD.
import type { FeaturedRun } from '../run.ts';
import { buildLayout } from './lots.ts';
import { LANES } from './types.ts';
import type { BeatId } from './types.ts';

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
}

export const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;
export const formatCount = (n: number) => Math.round(n).toLocaleString('en-US');

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** "One real run (run 2 of 2), not a median" plus the run's Claude-side cost and wall time. */
export function replayLabel(run: FeaturedRun): string {
  const which = run.attempts > 1 ? ` (run ${run.attempt} of ${run.attempts})` : '';
  return `One real run${which}, not a median · ${formatUsd(run.cost_usd)} · ${formatDuration(run.wall_s)}`;
}

export interface BeatCaption {
  id: BeatId;
  text: string;
  /** Extra sentence that appears once the plan is approved (plan beat only), e.g. the automatic approval. */
  approval?: string;
}

export function beatCaptions(run: FeaturedRun): BeatCaption[] {
  const layout = buildLayout(run);
  const originals = layout.lots.filter((l) => !l.extra);
  const annex = layout.lots.filter((l) => l.extra).map((l) => l.slug);
  const n = run.workers.length;
  const events = [...run.events].sort((a, b) => a.order - b.order);

  const laneCounts = LANES.map((lane) => ({ lane, n: run.workers.filter((w) => w.lane === lane).length })).filter((x) => x.n);
  const denied = run.workers.filter((w) => !w.ok && w.denied_count > 0).length;
  const fixed = run.workers.filter((w) => w.merged_via).map((w) => {
    const failedTests = events.some((e) => e.type === 'verify' && e.slug === w.slug && e.ok === false);
    return `${w.slug}${failedTests ? ' failed its tests and' : ''} was finished by a fixer branch (${w.merged_via})`;
  });
  // Branches whose first test run failed and that the orchestrator resumed (fixer-finished ones are told above).
  const resumed = run.workers.filter((w) => !w.merged_via && w.resumes > 0 && events.some((e) => e.type === 'verify' && e.slug === w.slug && e.ok === false)).map((w) => w.slug);
  const cross = events.filter((e) => e.type === 'review' && e.by === 'cross-model').length;
  const firstMerge = events.find((e) => e.type === 'merge');
  const firstCross = events.find((e) => e.type === 'review' && e.by === 'cross-model');
  const mergesFirst = !!firstMerge && (!firstCross || firstMerge.order < firstCross.order);

  // The longest stretch with no recorded event, if it is long enough to mention.
  let gap = { a: 0, b: 0 };
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1].t, b = events[i].t;
    if (typeof a === 'number' && typeof b === 'number' && b - a > gap.b - gap.a) gap = { a, b };
  }
  const gapText = gap.b - gap.a >= 120 ? ` Nothing was recorded between ${Math.round(gap.a)} s and ${Math.round(gap.b)} s.` : '';

  const unknown = originals.filter((l) => !l.tokensKnown).map((l) => l.slug);
  const tokens = LANES.filter((lane) => (run.worker_tokens?.[lane] ?? 0) > 0).map((lane) => `${lane} ${formatCount(run.worker_tokens[lane])}`);

  const approval = run.plan_approval === 'automatic' ? 'Plan approval was automatic in this headless run.'
    : run.plan_approval === 'human' ? 'A human approved the plan.' : undefined;

  return [
    { id: 'hero', text: 'Opus plans. Cheaper models build, in parallel. One config, three CLIs.' },
    { id: 'task', text: `The task: ${run.task}.` },
    { id: 'plan', text: `Opus plans first and splits the work into ${plural(n, 'part')}, one lot per worker.`, approval },
    {
      id: 'lanes',
      text: `${plural(n, 'worker')} build in parallel: ${list(laneCounts.map((x) => `${x.n} on ${x.lane}`))}.`,
    },
    {
      id: 'verify',
      text: ['Every branch is re-tested.',
        denied ? `${plural(denied, 'self-check')} reported "command denied".` : '',
        resumed.length ? `${list(resumed)} failed ${resumed.length === 1 ? 'its' : 'their'} first tests and ${resumed.length === 1 ? 'was' : 'were'} resumed.` : '',
        fixed.length ? `${list(fixed)}.` : ''].filter(Boolean).join(' '),
    },
    {
      id: 'merge',
      text: mergesFirst ? 'First merges into main, before the cross-model review.' : 'Branches merge into main.',
    },
    {
      id: 'review',
      text: `${plural(cross, 'cross-model review')} read the merged code.`
        + (annex.length ? ` The review leads to a small annex pass (${list(annex)}).` : '') + gapText,
    },
    {
      id: 'bill',
      text: `Claude side ${formatUsd(run.cost_usd)}, wall time ${formatDuration(run.wall_s)}, final tests ${run.verify_ok ? 'pass' : 'fail'}.`
        + (tokens.length ? ` Worker tokens (quota, not dollars): ${list(tokens)}` : '')
        + (tokens.length && unknown.length ? `; not recorded for ${list(unknown)}.` : tokens.length ? '.' : ''),
    },
  ];
}
