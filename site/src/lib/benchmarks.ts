// Reads public/data/benchmark_metrics.json when it exists. Absent file means "pending".
// Expected shape: { harness?: string, model?: string, rows: Array<Record<string, string | number>> }.
// A file that exists but does not match fails the build instead of rendering guesses.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Benchmarks {
  harness?: string;
  model?: string;
  columns: string[];
  rows: Array<Record<string, string | number>>;
  rawHref: string;
}

/** What the page says produced the numbers: the recorded harness and model, 'pending' with no data file, 'not recorded' if the file names neither. */
export function harnessOf(bench: Benchmarks | null): string {
  return bench ? [bench.harness, bench.model].filter(Boolean).join(', ') || 'not recorded' : 'pending';
}

export function loadBenchmarks(): Benchmarks | null {
  const file = resolve(process.cwd(), 'public/data/benchmark_metrics.json');
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.rows) || data.rows.length === 0) {
    throw new Error('benchmark_metrics.json must contain a non-empty "rows" array');
  }
  const columns = [...new Set<string>(data.rows.flatMap((r: object) => Object.keys(r)))];
  return { harness: data.harness, model: data.model, columns, rows: data.rows, rawHref: '/data/benchmark_metrics.json' };
}
