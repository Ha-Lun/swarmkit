import type { TokenUsage } from '../../src/shared/types.ts';

/** Per-million-token rates. */
interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const RATES: Record<string, Rate> = {
  opus: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Maps a raw model id (or alias) to a pricing tier, or undefined when unknown. */
export function modelTier(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (model in RATES) return model;
  const m = model.toLowerCase();
  if (m.includes('claude-opus')) return 'opus';
  if (m.includes('claude-sonnet')) return 'sonnet';
  if (m.includes('claude-haiku')) return 'haiku';
  return undefined;
}

/**
 * Estimated cost in USD for one usage record at the given model's rates.
 * Unknown models cost 0.
 */
export function estimateCost(model: string | undefined, usage: TokenUsage): number {
  const rate = RATES[modelTier(model) ?? ''];
  if (!rate) return 0;
  const u = usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const total =
    num(u.input) * rate.input +
    num(u.output) * rate.output +
    num(u.cacheRead) * rate.cacheRead +
    num(u.cacheWrite) * rate.cacheWrite;
  return total / 1_000_000;
}

function num(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
