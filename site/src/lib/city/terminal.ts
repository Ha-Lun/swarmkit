// Terminal replay panel: turns the featured run's recorded events into terminal lines. Pure (tests in
// test/city/terminal.test.ts). Every number comes from the run; wording rules: worker tokens are quota, never USD;
// a self-check ok:false is "command denied" (mostly "a command was denied"), never failed code; reviews carry no
// verdict. Type-only imports keep this file erasable under plain node.
import type { FeaturedRun } from '../run.ts';
import type { Lane } from '../run.ts';
import type { BeatId } from './types.ts';
import { formatDuration } from './captions.ts';

export type TermKind = 'prompt' | 'plan' | 'dispatch' | 'done' | 'resume' | 'test' | 'review' | 'merge' | 'final';

export interface TermLine {
  t: number;
  order: number;
  kind: TermKind;
  lane?: Lane;
  slug?: string;
  ok?: boolean;
  text: string;
}

/** "[mm:ss]" for run seconds, floored, e.g. stamp(83) === '[01:23]'. */
export function stamp(t: number): string {
  const s = Math.max(0, Math.floor(t));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `[${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}]`;
}

export type ChapterId = 1 | 2 | 3 | 4 | 5;

export const CHAPTERS: Record<ChapterId, { title: string; line: string }> = {
  1: { title: 'You ask', line: 'One prompt to the orchestrator.' },
  2: { title: 'Opus plans', line: 'The expensive model thinks once and splits the job.' },
  3: { title: 'Cheap models build', line: 'Workers on other quotas build in parallel.' },
  4: { title: 'Every branch is checked', line: 'Tests rerun, diffs reviewed, then merged.' },
  5: { title: 'Done', line: 'One real run, start to finish.' },
};

export function chapterFor(beat: BeatId): ChapterId {
  switch (beat) {
    case 'hero':
    case 'task':
      return 1;
    case 'plan':
      return 2;
    case 'lanes':
      return 3;
    case 'verify':
    case 'merge':
    case 'review':
      return 4;
    case 'bill':
      return 5;
  }
}

/** One or more terminal lines per event, sorted by (t, order). Events without t take the previous line's t. */
export function buildTerminalLines(run: FeaturedRun): TermLine[] {
  const events = [...run.events].sort((a, b) => a.order - b.order);
  const workersBySlug = new Map(run.workers.map((w) => [w.slug, w]));
  const lines: TermLine[] = [];
  let seq = 0;
  let prevT = 0;
  let hasPrev = false;

  const push = (t: number, kind: TermKind, body: string, extra?: { lane?: Lane; slug?: string; ok?: boolean }) => {
    const line: TermLine = { t, order: seq++, kind, text: `${stamp(t)} ${body}` };
    if (extra?.lane !== undefined) line.lane = extra.lane;
    if (extra?.slug !== undefined) line.slug = extra.slug;
    if (extra?.ok !== undefined) line.ok = extra.ok;
    lines.push(line);
  };

  for (const e of events) {
    const t = typeof e.t === 'number' && Number.isFinite(e.t) ? e.t : hasPrev ? prevT : 0;
    switch (e.type) {
      case 'task':
        push(t, 'prompt', '$ claude --agent lead-dev-hybrid');
        push(t, 'prompt', `> ${run.task}`);
        break;
      case 'plan_mode':
        push(t, 'plan', 'Opus · planning');
        break;
      case 'plan_approved':
        push(t, 'plan', `Opus · plan approved (${run.plan_approval})`);
        break;
      case 'dispatch': {
        const lane = e.lane;
        const body = e.extra && e.base
          ? `▸ ${lane} · ${e.slug} started (fixer for ${e.base})`
          : `▸ ${lane} · ${e.slug} started`;
        push(t, 'dispatch', body, { lane: e.lane, slug: e.slug });
        break;
      }
      case 'worker_done': {
        const w = e.slug !== undefined ? workersBySlug.get(e.slug) : undefined;
        const ok = e.ok ?? w?.ok;
        const lane = e.lane ?? w?.lane;
        const denied = w?.denied_count ?? 0;
        const body = ok === true
          ? `✓ ${lane} · ${e.slug} done`
          : denied > 0
            ? `• ${lane} · ${e.slug} done · self-check flagged: ${denied} command(s) denied`
            : `• ${lane} · ${e.slug} done · self-check flagged`;
        push(t, 'done', body, { lane, slug: e.slug, ok });
        break;
      }
      case 'resume': {
        const body = e.lane ? `↻ ${e.lane} · ${e.slug} resumed` : `↻ ${e.slug} resumed`;
        push(t, 'resume', body, { lane: e.lane, slug: e.slug });
        break;
      }
      case 'verify': {
        const body = e.ok ? `✓ tests pass · ${e.slug}` : `✗ tests fail · ${e.slug}`;
        push(t, 'test', body, { slug: e.slug, ok: e.ok });
        break;
      }
      case 'review': {
        const body = e.by === 'cross-model'
          ? (e.slug ? `cross-model review · ${e.slug}` : 'cross-model review')
          : (e.slug ? `Opus reviewed · ${e.slug}` : 'Opus reviewed');
        push(t, 'review', body, { lane: e.lane, slug: e.slug });
        break;
      }
      case 'merge':
        push(t, 'merge', `⇢ merged · ${e.slug}`, { lane: e.lane, slug: e.slug });
        break;
      case 'done':
        push(t, 'final', `done · final tests ${run.verify_ok ? 'pass' : 'fail'} · $${run.cost_usd.toFixed(2)} · ${formatDuration(run.wall_s)}`);
        break;
    }
    prevT = t;
    hasPrev = true;
  }

  lines.sort((a, b) => a.t - b.t || a.order - b.order);
  return lines;
}

/** Lines with t <= runTime, in order. */
export function visibleLines(lines: TermLine[], runTime: number): TermLine[] {
  return lines.filter((l) => l.t <= runTime).sort((a, b) => a.t - b.t || a.order - b.order);
}
