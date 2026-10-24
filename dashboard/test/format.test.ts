import { describe, expect, it } from 'vitest';
import { fmtResetIn, fmtTokens, parseIso, usageTone } from '../src/client/format.ts';

describe('fmtTokens', () => {
  it('picks the unit after rounding', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1000)).toBe('1k');
    expect(fmtTokens(999_950)).toBe('1.0M');
    expect(fmtTokens(1_234_567)).toBe('1.2M');
    expect(fmtTokens(9_960_000)).toBe('10.0M');
  });
});

describe('parseIso', () => {
  it('trims sub-millisecond digits', () => {
    expect(parseIso('2026-01-01T00:00:00.123456+00:00')).toBe(Date.parse('2026-01-01T00:00:00.123Z'));
  });
  it('returns NaN for garbage', () => {
    expect(parseIso('nope')).toBeNaN();
  });
});

describe('fmtResetIn', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const at = (ms: number) => new Date(now + ms).toISOString();
  it('formats relative times', () => {
    expect(fmtResetIn(at(-5000), now)).toBe('now');
    expect(fmtResetIn(at(20_000), now)).toBe('now');
    expect(fmtResetIn(at(90 * 60_000), now)).toBe('in 1h 30m');
    expect(fmtResetIn(at(30 * 3_600_000), now)).toMatch(/^\w{3} \d{2}:\d{2}$/);
  });
  it('accepts microsecond +00:00 input', () => {
    expect(fmtResetIn('2026-01-01T01:30:00.123456+00:00', now)).toBe('in 1h 30m');
  });
  it('is empty for unparseable input', () => {
    expect(fmtResetIn('x', now)).toBe('');
  });
});

describe('usageTone', () => {
  it('maps thresholds', () => {
    expect(usageTone(74)).toBe('teal');
    expect(usageTone(75)).toBe('amber');
    expect(usageTone(89)).toBe('amber');
    expect(usageTone(90)).toBe('fail');
    expect(usageTone(NaN)).toBe('idle');
  });
});
