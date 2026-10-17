// Reads public/data/featured-run.json (written by scripts/export-run.py): ONE real benchmark run, replayed by the
// scene. Absent file means no replay. The file is allowlisted at export time; the loader re-checks the shape and
// refuses anything that looks like a leaked path.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type EventType =
  | 'task' | 'plan_mode' | 'plan_approved' | 'dispatch' | 'worker_done'
  | 'verify' | 'review' | 'merge' | 'resume' | 'done';

export interface RunEvent {
  type: EventType;
  /** Seconds from the start of the run; absent when the transcript had no timestamps. */
  t?: number;
  /** Position in the transcript; always present. */
  order: number;
  slug?: string;
  lane?: Lane;
  ok?: boolean;
  /** Review events only: who read the diff. */
  by?: 'orchestrator' | 'cross-model';
  /** A branch no original worker owns (a fixer stacked on a worker branch, a review-fix pass) that was merged. */
  extra?: boolean;
  /** Dispatch of an extra only: the worker whose branch it was stacked on. */
  base?: string;
}

export interface RunWorker {
  slug: string;
  /** The final lane. */
  lane: Lane;
  /** The worker's own self-check as recorded by its wrapper (a denied command makes it false). Not whether the code was right. */
  ok: boolean;
  tokens: number;
  denied_count: number;
  files: string[];
  /** Every lane a start was recorded on, in order; the last is `lane`. */
  lanes_tried: Lane[];
  /** How many times the orchestrator resumed this worker. */
  resumes: number;
  /** Its work reached the merged result: its own branch merged, or a fixer stacked on it did (`merged_via`). */
  merged: boolean;
  merged_via?: string;
}

export type Lane = 'agy' | 'opencode';
export type PlanApproval = 'automatic' | 'human';

export interface FeaturedRun {
  label: string;
  task: string;
  case: string;
  variant: string;
  model: string | null;
  cost_usd: number;
  wall_s: number;
  duration_s: number;
  turns: number;
  verify_ok: boolean;
  /** Quota on the worker subscriptions, never USD. */
  worker_tokens: Record<string, number>;
  lanes: Lane[];
  /** Which try of the showcase this is, how many there were, and what happened in the others. */
  attempt: number;
  attempts: number;
  earlier_attempts: string[];
  /** Present when attempts > 1, e.g. "Run 2 of 2". */
  attempt_label?: string;
  plan_approval?: PlanApproval;
  workers: RunWorker[];
  events: RunEvent[];
}

const KINDS = new Set<string>(['task', 'plan_mode', 'plan_approved', 'dispatch', 'worker_done', 'verify', 'review', 'merge', 'resume', 'done']);
const LANES = new Set<string>(['agy', 'opencode']);
const APPROVALS = new Set<string>(['automatic', 'human']);
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const FORBIDDEN_RE = /\/home\/|\/Users\/|\/root\/|\/tmp\/|\/var\/|\/private\/|[a-z]:\\|~\/|\$HOME|file:\/\/|https?:\/\/|@|(?:\d{1,3}\.){3}\d{1,3}|sk-|ghp_|gho_|github_pat_|AKIA|xox[abps]-|AIza|glpat-|bearer|\.opencode-tasks|EOF|[A-Za-z0-9+\/=_-]{32,}/i;

/** Throws on a string that looks like a leaked path or secret anywhere in the parsed JSON. */
export function assertClean(v: unknown): void {
  if (typeof v === 'string') {
    if (v.length > 120) throw new Error('string longer than 120 chars');
    if (FORBIDDEN_RE.test(v)) throw new Error('featured-run.json contains a forbidden string');
    return;
  }
  if (Array.isArray(v)) {
    v.forEach(assertClean);
    return;
  }
  if (v && typeof v === 'object') {
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      assertClean(key);
      assertClean(value);
    }
  }
}

export function loadFeaturedRun(): FeaturedRun | null {
  const file = resolve(process.cwd(), 'public/data/featured-run.json');
  if (!existsSync(file)) return null;
  const run = JSON.parse(readFileSync(file, 'utf8'));
  assertClean(run);
  if (typeof run.task !== 'string' || typeof run.cost_usd !== 'number' || typeof run.wall_s !== 'number') {
    throw new Error('featured-run.json needs "task", "cost_usd" and "wall_s"');
  }
  if (!Array.isArray(run.events) || run.events.length === 0 || !Array.isArray(run.workers)) {
    throw new Error('featured-run.json needs non-empty "events" and a "workers" array');
  }
  if (!Array.isArray(run.lanes) || run.lanes.some((lane: unknown) => typeof lane !== 'string' || !LANES.has(lane))) {
    throw new Error('featured-run.json has an invalid lane');
  }
  const isCount = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  if (!Number.isInteger(run.attempt) || !Number.isInteger(run.attempts) || run.attempt < 1 || run.attempt > run.attempts) {
    throw new Error('featured-run.json has an invalid attempt/attempts');
  }
  if (!Array.isArray(run.earlier_attempts) || run.earlier_attempts.length > 5
    || run.earlier_attempts.some((n: unknown) => typeof n !== 'string' || n.length === 0 || n.length > 100)) {
    throw new Error('featured-run.json has invalid earlier_attempts');
  }
  if (run.attempt_label !== undefined && (typeof run.attempt_label !== 'string' || run.attempts < 2)) {
    throw new Error('featured-run.json has an invalid attempt_label');
  }
  if (run.plan_approval !== undefined && !APPROVALS.has(run.plan_approval)) throw new Error('featured-run.json has an invalid plan_approval');
  for (const worker of run.workers) {
    if (typeof worker?.slug !== 'string' || !SLUG_RE.test(worker.slug)) throw new Error('featured-run.json has an invalid worker slug');
    if (typeof worker?.lane !== 'string' || !LANES.has(worker.lane)) throw new Error('featured-run.json has an invalid worker lane');
    if (!Array.isArray(worker.lanes_tried) || worker.lanes_tried.length === 0
      || worker.lanes_tried.some((lane: unknown) => typeof lane !== 'string' || !LANES.has(lane))) {
      throw new Error('featured-run.json has an invalid worker lanes_tried');
    }
    if (!isCount(worker.resumes) || typeof worker.merged !== 'boolean') throw new Error('featured-run.json has an invalid worker resumes/merged');
    if (worker.merged_via !== undefined && (typeof worker.merged_via !== 'string' || !SLUG_RE.test(worker.merged_via))) {
      throw new Error('featured-run.json has an invalid worker merged_via');
    }
  }
  for (const e of run.events) {
    if (!KINDS.has(e.type) || typeof e.order !== 'number') throw new Error(`featured-run.json has a bad event: ${JSON.stringify(e).slice(0, 80)}`);
    if (typeof e.lane === 'string' && !LANES.has(e.lane)) throw new Error(`featured-run.json has a bad event: ${JSON.stringify(e).slice(0, 80)}`);
    if (e.extra !== undefined && e.extra !== true) throw new Error(`featured-run.json has a bad event: ${JSON.stringify(e).slice(0, 80)}`);
    if (e.base !== undefined && (typeof e.base !== 'string' || !SLUG_RE.test(e.base))) throw new Error(`featured-run.json has a bad event: ${JSON.stringify(e).slice(0, 80)}`);
  }
  return run as FeaturedRun;
}

/** Event positions in 0..1: t / wall_s when every event has a time, else order index over length. */
export function timelineOf(run: Pick<FeaturedRun, 'events' | 'wall_s'>): number[] {
  const { events, wall_s } = run;
  const timed = wall_s > 0 && events.every((e) => typeof e.t === 'number');
  return events.map((e, i) => {
    const p = timed ? (e.t as number) / wall_s : events.length > 1 ? i / (events.length - 1) : 0;
    return Math.min(1, Math.max(0, p));
  });
}
