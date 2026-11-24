import { describe, expect, it } from 'vitest';
import { canUseOpus, fmtBytes, fmtLimitReset, fmtResetIn, fmtTokens, goPillModel, modelLabel, parseIso, sessionHint, sessionSubline, triageNote, triageText, usageTone } from '../src/client/format.ts';

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

describe('fmtBytes', () => {
  it('picks the unit after rounding', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(-5)).toBe('0 B');
    expect(fmtBytes(812)).toBe('812 B');
    expect(fmtBytes(1023)).toBe('1023 B');
    expect(fmtBytes(1024)).toBe('1.0 KB');
    expect(fmtBytes(1536)).toBe('1.5 KB');
    expect(fmtBytes(348_160)).toBe('340 KB');
    expect(fmtBytes(1024 * 1024 - 100)).toBe('1.0 MB');
    expect(fmtBytes(1_258_291)).toBe('1.2 MB');
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(fmtBytes(Number.NaN)).toBe('0 B');
  });
});

describe('fmtLimitReset', () => {
  const now = new Date(2026, 10, 15, 10, 0).getTime();
  it('shows only the clock when the reset is today', () => {
    expect(fmtLimitReset(new Date(2026, 10, 15, 14, 10).toISOString(), now)).toBe('14:10');
  });
  it('adds the weekday when the reset is on another day', () => {
    expect(fmtLimitReset(new Date(2026, 10, 16, 3, 5).toISOString(), now)).toMatch(/^\S+ 03:05$/);
  });
  it('is empty for an unparseable value', () => {
    expect(fmtLimitReset('soon', now)).toBe('');
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

describe('session labels', () => {
  const s = {
    id: 'abcdef123456',
    title: 'Fix it',
    project: 'proj',
    cwd: '/x/proj',
    agent: 'lead-dev',
    model: 'claude-opus-5-5',
    updatedAt: 0,
  } as unknown as import('../src/shared/types').SessionSummary;
  it('joins present parts and omits missing ones', () => {
    expect(sessionSubline(s, undefined, true)).toBe('proj · lead-dev · Opus 5.5');
    expect(sessionSubline({ ...s, agent: undefined, model: undefined }, undefined, false)).toBe('');
  });
  it('hint carries title, cwd, agent, model and short id', () => {
    expect(sessionHint(s)).toBe('Fix it · /x/proj · agent lead-dev · model Opus 5.5 · id abcdef12');
  });
});

describe('goPillModel', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const lim = (window: 'rolling' | 'weekly' | 'monthly', utilization: number | null, limited = false) => ({
    window, utilization, resetsAt: '2026-01-01T02:00:00Z', limited,
  });
  it('is null without limits', () => {
    expect(goPillModel(undefined)).toBeNull();
    expect(goPillModel([])).toBeNull();
  });
  it('uses the rolling percent and tone', () => {
    const m = goPillModel([lim('rolling', 34), lim('weekly', 61)], now);
    expect(m?.pct).toBe(34);
    expect(m?.tone).toBe('teal');
    expect(m?.label).toContain('rolling 34% (resets in 2h 0m)');
  });
  it('forces danger when any window is limited', () => {
    const m = goPillModel([lim('rolling', 10), lim('weekly', 100, true)], now);
    expect(m?.tone).toBe('fail');
    expect(m?.label).toContain('rate-limited');
  });
});

describe('modelLabel', () => {
  it('keeps the Claude short names', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(modelLabel('sonnet')).toBe('Sonnet');
  });

  it('shortens worker model ids', () => {
    expect(modelLabel('gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash · high');
    expect(modelLabel('gemini-4-argon-high')).toBe('Gemini 4 Argon · high');
    expect(modelLabel('gemini-4-hydrogen-xhigh')).toBe('Gemini 4 Hydrogen · xhigh');
    expect(modelLabel('opencode-go/muse-spark-1.3-contributor')).toBe('Muse Spark 1.3');
    expect(modelLabel('opencode-go/glm-5.3-flash')).toBe('GLM 5.3 Flash');
    expect(modelLabel('opencode-go/deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash');
    expect(modelLabel('opencode-go/mimo-v2.6-flash')).toBe('MiMo V2.6 Flash');
  });

  it('is empty for a missing model and never throws on odd ids', () => {
    expect(modelLabel(undefined)).toBe('');
    expect(modelLabel('')).toBe('');
    expect(modelLabel('provider/')).toBe('');
    expect(modelLabel('high')).toBe('High');
  });
});

describe('fable pricing', () => {
  it('prices claude-fable-5-1 at the Fable tier', async () => {
    const { estimateCost, modelTier } = await import('../server/model/pricing.ts');
    expect(modelTier('claude-fable-5-1')).toBe('fable');
    expect(estimateCost('claude-fable-5-1', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(60);
  });
});

describe('triageText', () => {
  it('shows level, the session model and the reason', () => {
    expect(triageText({ level: 'trivial', reason: 'single-file rename', source: 'model' }, 'sonnet')).toBe('trivial → Sonnet · single-file rename');
    expect(triageText({ level: 'normal', reason: 'new endpoint', source: 'model' }, 'claude-sonnet-5-5')).toBe('normal → Sonnet 5.5 · new endpoint');
  });
  it('shows the model now in use, even after a switch to Opus', () => {
    expect(triageText({ level: 'trivial', reason: 'typo', source: 'model' }, 'opus')).toBe('trivial → Opus · typo');
  });
  it('falls back to the model the level implies when the session has none', () => {
    expect(triageText({ level: 'trivial', reason: '', source: 'model' })).toBe('trivial → Sonnet');
    expect(triageText({ level: 'hard', reason: 'cross-cutting', source: 'model' })).toBe('hard → Opus · cross-cutting');
  });
  it('names a failed triage and keeps a non-empty reason', () => {
    expect(triageText({ level: 'hard', reason: '', source: 'fallback' }, 'opus')).toBe('failed → Opus');
    expect(triageText({ level: 'hard', reason: 'timeout', source: 'fallback' })).toBe('failed → Opus · timeout');
  });
});

describe('canUseOpus', () => {
  it('offers Opus for Claude sessions on Sonnet, short or full id', () => {
    expect(canUseOpus({ runtime: 'claude', model: 'sonnet' })).toBe(true);
    expect(canUseOpus({ model: 'claude-sonnet-5-5' })).toBe(true);
  });
  it('not once the model is Opus, Haiku or unknown', () => {
    expect(canUseOpus({ runtime: 'claude', model: 'claude-opus-5-5' })).toBe(false);
    expect(canUseOpus({ model: 'opus' })).toBe(false);
    expect(canUseOpus({ model: 'claude-haiku-4-5-20251001' })).toBe(false);
    expect(canUseOpus({})).toBe(false);
  });
  it('not for OpenCode or Antigravity sessions', () => {
    expect(canUseOpus({ runtime: 'opencode', model: 'sonnet' })).toBe(false);
    expect(canUseOpus({ runtime: 'agy', model: 'claude-sonnet-5-5' })).toBe(false);
  });
});

describe('triageNote', () => {
  it('names the picked model with its version, the level and the reason', () => {
    expect(triageNote({ level: 'trivial', reason: 'single typo fix', source: 'model' }, 'claude-sonnet-5-5')).toBe('Auto picked Sonnet 5.5 · trivial · single typo fix');
    expect(triageNote({ level: 'hard', reason: '', source: 'model' }, 'opus')).toBe('Auto picked Opus · hard');
  });
  it('says when triage failed', () => {
    expect(triageNote({ level: 'hard', reason: '', source: 'fallback' }, 'claude-opus-5-5')).toBe('Auto picked Opus 5.5 · triage failed');
  });
  it('keeps the original pick after a switch to Opus, and works before the model is known', () => {
    expect(triageNote({ level: 'normal', reason: 'ui toggle', source: 'model' }, 'claude-opus-5-5')).toBe('Auto picked Sonnet · normal · ui toggle');
    expect(triageNote({ level: 'trivial', reason: 'x', source: 'model' })).toBe('Auto picked Sonnet · trivial · x');
  });
});
