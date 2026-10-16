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
  lane?: string;
  ok?: boolean;
  /** Review events only: who read the diff. */
  by?: 'orchestrator' | 'cross-model';
}

export interface RunWorker { slug: string; lane: string; ok: boolean; tokens: number; denied_count: number; files: string[] }

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
  lanes: string[];
  workers: RunWorker[];
  events: RunEvent[];
}

const KINDS = new Set<string>(['task', 'plan_mode', 'plan_approved', 'dispatch', 'worker_done', 'verify', 'review', 'merge', 'resume', 'done']);

/** Throws on a string that looks like a leaked path anywhere in the parsed JSON. */
function assertClean(v: unknown): void {
  if (typeof v === 'string' && v.includes('/home/')) throw new Error('featured-run.json contains a home path');
  if (v && typeof v === 'object') Object.values(v).forEach(assertClean);
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
  for (const e of run.events) {
    if (!KINDS.has(e.type) || typeof e.order !== 'number') throw new Error(`featured-run.json has a bad event: ${JSON.stringify(e).slice(0, 80)}`);
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
