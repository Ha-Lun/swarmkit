// Reads public/data/benchmark_metrics.json (written by scripts/export-bench.py). Absent file means "pending".
// Shape: { harness, models[], minRuns, cells[], voided[], pending[], rows[], notes[] }. Only cells with at least
// minRuns counted runs are published; voided cells and pending cells carry no numbers. A file that exists but
// does not match fails the build instead of rendering guesses.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Spread { min: number; median: number; max: number }

/** A published cell: one case, variant and model, with spread over its n counted runs. */
export interface Cell {
  case: string;
  variant: string;
  model: string;
  n: number;
  cost_usd: Spread;
  wall_s: Spread;
  turns: { median: number };
  /** Median worker tokens per lane. Quota on the worker subscriptions, never USD. */
  worker_tokens: Record<string, number>;
  worker_tasks_median: number;
  worker_oks_median: number;
  pass_rate: number;
}

/** A cell with a failed or errored run: reason only, never numbers. */
export interface Voided { case: string; variant: string; model: string; n: number; reason: string }
/** A cell with fewer than minRuns counted runs: counts only. */
export interface Pending { case: string; variant: string; model: string; n: number }

export interface Benchmarks {
  harness?: string;
  models: string[];
  minRuns: number;
  cells: Cell[];
  voided: Voided[];
  pending: Pending[];
  notes: string[];
  columns: string[];
  rows: Array<Record<string, string | number>>;
  rawHref: string;
}

/** What the page says produced the numbers: the recorded harness and models, 'pending' with no data file, 'not recorded' if the file names neither. */
export function harnessOf(bench: Benchmarks | null): string {
  return bench ? [bench.harness, bench.models.join(', ')].filter(Boolean).join(', ') || 'not recorded' : 'pending';
}

const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);

export function loadBenchmarks(): Benchmarks | null {
  const file = resolve(process.cwd(), 'public/data/benchmark_metrics.json');
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.rows) || data.rows.length === 0) {
    throw new Error('benchmark_metrics.json must contain a non-empty "rows" array');
  }
  const minRuns = Number(data.minRuns);
  if (!Number.isInteger(minRuns) || minRuns < 1) throw new Error('benchmark_metrics.json needs an integer "minRuns"');
  const cells: Cell[] = list(data.cells);
  for (const c of cells) {
    if (!(c.n >= minRuns)) throw new Error(`published cell ${c.case}/${c.variant}/${c.model} has ${c.n} runs, below minRuns ${minRuns}`);
  }
  const columns = [...new Set<string>(data.rows.flatMap((r: object) => Object.keys(r)))];
  return {
    harness: data.harness,
    models: list(data.models),
    minRuns,
    cells,
    voided: list(data.voided),
    pending: list(data.pending),
    notes: list(data.notes),
    columns,
    rows: data.rows,
    rawHref: '/data/benchmark_metrics.json',
  };
}
