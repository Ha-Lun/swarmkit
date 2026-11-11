import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENCE_INTERVAL_MS, startPresence, type PresenceEnv } from '../src/client/presence.ts';
import { PLAN_MODE_HINT, planChoices, UNTRUSTED_PLAN_NOTE } from '../src/client/Permission.tsx';
import { createMockBackend } from '../src/client/mock.ts';

function fakeEnv(id = 'tab-1') {
  const listeners = new Map<string, Set<() => void>>();
  const target = () => ({
    addEventListener: (t: string, fn: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn),
    removeEventListener: (t: string, fn: () => void) => void listeners.get(t)?.delete(fn),
  });
  const doc = { ...target(), visibilityState: 'visible' };
  const env: PresenceEnv = { doc, win: target(), newId: () => id };
  const fire = (t: string) => listeners.get(t)?.forEach((fn) => fn());
  return { env, doc, fire, listeners };
}

describe('startPresence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reports visible on start and repeats every 45 s while visible', () => {
    const presence = vi.fn().mockResolvedValue({ ok: true });
    const { env } = fakeEnv();
    startPresence({ presence }, env);
    expect(presence).toHaveBeenCalledTimes(1);
    expect(presence).toHaveBeenLastCalledWith({ visible: true, id: 'tab-1' }, undefined);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    expect(presence).toHaveBeenCalledTimes(3);
  });

  it('sends on visibility change and stops the interval while hidden', () => {
    const presence = vi.fn().mockResolvedValue({ ok: true });
    const { env, doc, fire } = fakeEnv();
    startPresence({ presence }, env);
    doc.visibilityState = 'hidden';
    fire('visibilitychange');
    expect(presence).toHaveBeenLastCalledWith({ visible: false, id: 'tab-1' }, undefined);
    const calls = presence.mock.calls.length;
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 3);
    expect(presence).toHaveBeenCalledTimes(calls);
    doc.visibilityState = 'visible';
    fire('visibilitychange');
    expect(presence).toHaveBeenLastCalledWith({ visible: true, id: 'tab-1' }, undefined);
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS);
    expect(presence).toHaveBeenCalledTimes(calls + 2);
  });

  it('sends a keepalive hidden report on pagehide', () => {
    const presence = vi.fn().mockResolvedValue({ ok: true });
    const { env, fire } = fakeEnv();
    startPresence({ presence }, env);
    fire('pagehide');
    expect(presence).toHaveBeenLastCalledWith({ visible: false, id: 'tab-1' }, true);
    const calls = presence.mock.calls.length;
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    expect(presence).toHaveBeenCalledTimes(calls);
  });

  it('swallows send errors', async () => {
    const presence = vi.fn().mockRejectedValue(new Error('offline'));
    const { env } = fakeEnv();
    expect(() => startPresence({ presence }, env)).not.toThrow();
    await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
  });

  it('stop removes listeners and the timer', () => {
    const presence = vi.fn().mockResolvedValue({ ok: true });
    const { env, listeners } = fakeEnv();
    const stop = startPresence({ presence }, env);
    stop();
    vi.advanceTimersByTime(PRESENCE_INTERVAL_MS * 2);
    expect(presence).toHaveBeenCalledTimes(1);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
  });

  it('is a network no-op on the mock backend', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('window', globalThis); // the mock schedules its script on window timers
    try {
      const { env } = fakeEnv();
      startPresence(createMockBackend(), env);
      await vi.advanceTimersByTimeAsync(PRESENCE_INTERVAL_MS);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('planChoices', () => {
  it('orders manual, accept edits, auto with manual primary', () => {
    const c = planChoices(false);
    expect(c.map((x) => x.label)).toEqual(['Approve · manual', 'Approve · accept edits', 'Approve · auto mode']);
    expect(c.map((x) => x.mode)).toEqual([undefined, 'acceptEdits', 'auto']);
    expect(c.map((x) => x.primary)).toEqual([true, false, false]);
  });

  it('offers only a manual Approve in untrusted projects', () => {
    expect(planChoices(true)).toEqual([expect.objectContaining({ label: 'Approve', primary: true })]);
    expect(planChoices(true)[0]!.mode).toBeUndefined();
  });

  it('keeps the hint in button order', () => {
    expect(PLAN_MODE_HINT.indexOf('Manual')).toBeLessThan(PLAN_MODE_HINT.indexOf('Accept edits'));
    expect(PLAN_MODE_HINT.indexOf('Accept edits')).toBeLessThan(PLAN_MODE_HINT.indexOf('Auto'));
    expect(UNTRUSTED_PLAN_NOTE).toBe('Untrusted project: mode stays manual.');
  });
});
