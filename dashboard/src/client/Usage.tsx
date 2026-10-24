// Usage panel: Claude plan limits + opencode / agy consumption. Polled every 60s
// while the tab is visible; keeps the last good report through failures.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { FleetBackend, Guard } from './api';
import type { UsageLimit, UsageReport } from '../shared/types';
import { fmtClockShort, fmtCost, fmtResetIn, fmtTokens, usageTone } from './format';

/** Fetch on mount, then every 60s while `active` and visible; refetch when the tab becomes visible. */
export function useUsage(
  backend: FleetBackend,
  guard: Guard,
  active: boolean,
): { report: UsageReport | null; loading: boolean; refresh: () => void } {
  const [report, setReport] = useState<UsageReport | null>(null);
  // Request sequence: only the newest in-flight response may call setReport.
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const pull = useCallback(
    (refresh: boolean) => {
      if (!active) return;
      const id = ++seq.current;
      guard(backend.usage(refresh))
        .then((r) => {
          if (alive.current && r && id === seq.current) setReport(r);
        })
        .catch(() => undefined); // stale report stays; a 401 flips the UI via guard
    },
    [active, backend, guard],
  );

  useEffect(() => {
    if (!active) return;
    // Skip the mount pull when the tab is hidden — visibilitychange handles the wake-up.
    if (document.visibilityState !== 'hidden') pull(false);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') pull(false);
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') pull(false);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, pull]);

  const refresh = useCallback(() => pull(true), [pull]);

  // `loading` is derived: the very first report hasn't landed yet while we poll.
  return { report, loading: report === null && active, refresh };
}

function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function UsageCard({ source, title, children }: { source: string; title: string; children: ReactNode }) {
  return (
    <div className={`usage-card is-${source}`}>
      <h3 className="usage-name">{title}</h3>
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
  label,
}: {
  options: Array<{ days: number; label: string; a11y: string }>;
  value: number;
  onChange: (days: number) => void;
  label: string;
}) {
  return (
    <div className="usage-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.days}
          type="button"
          aria-label={o.a11y}
          aria-pressed={o.days === value || undefined}
          onClick={() => onChange(o.days)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const SEG_OPTIONS = [
  { days: 1, label: '1d', a11y: 'Last 1 day' },
  { days: 7, label: '7d', a11y: 'Last 7 days' },
  { days: 30, label: '30d', a11y: 'Last 30 days' },
];

const AGY_OPTIONS = SEG_OPTIONS.slice(0, 2);

function UsageBar({ label, limit }: { label: string; limit: UsageLimit }) {
  const u = limit.utilization;
  if (u == null || !Number.isFinite(u)) {
    return (
      <p className="usage-limit-top">
        <span className="usage-label">{label}</span>
        <span className="usage-pct muted">—</span>
      </p>
    );
  }
  const pct = Math.round(Math.min(100, Math.max(0, u)));
  const tone = usageTone(u);
  return (
    <div className="usage-limit">
      <div className="usage-limit-top">
        <span className="usage-label">{label}</span>
        <span className={`usage-pct tone-${tone}`}>{pct}%</span>
      </div>
      <div
        className="usage-bar"
        role="meter"
        aria-label={`${label} utilization`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`usage-fill tone-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {limit.resetsAt ? textOrNothing('resets ', fmtResetIn(limit.resetsAt)) : null}
    </div>
  );
}

/** Renders nothing when the formatted value is empty (unparseable date). */
function textOrNothing(prefix: string, value: string): ReactNode {
  return value ? <p className="usage-reset muted">{prefix}{value}</p> : null;
}

type LimitKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';

const LIMITS: Array<{ key: LimitKey; label: string }> = [
  { key: 'fiveHour', label: '5-hour window' },
  { key: 'sevenDay', label: '7-day' },
  { key: 'sevenDayOpus', label: '7-day Opus' },
  { key: 'sevenDaySonnet', label: '7-day Sonnet' },
];

function ClaudeCard({ claude }: { claude: UsageReport['claude'] }) {
  if (!claude.available) {
    return (
      <UsageCard source="claude" title="Claude">
        <p className="usage-none muted">Limits unavailable{claude.error ? ` — ${claude.error}` : ''}</p>
      </UsageCard>
    );
  }
  const sub = claude.subscription
    ? claude.subscription.charAt(0).toUpperCase() + claude.subscription.slice(1)
    : '';
  return (
    <UsageCard source="claude" title={`Plan limits${sub ? ` · ${sub}` : ''}`}>
      {LIMITS.map(({ key, label }) => {
        const l = claude[key];
        return l ? <UsageBar key={key} label={label} limit={l} /> : null;
      })}
      {claude.source === 'session' && <p className="usage-note muted">from the last live session</p>}
    </UsageCard>
  );
}

function OpenCodeCard({
  oc,
  days,
  onDays,
}: {
  oc: UsageReport['opencode'];
  days: number;
  onDays: (d: number) => void;
}) {
  if (!oc.available) {
    return (
      <UsageCard source="opencode" title="OpenCode">
        <p className="usage-none muted">Unavailable{oc.error ? ` — ${oc.error}` : ''}</p>
      </UsageCard>
    );
  }
  const win = oc.windows.find((w) => w.days === days);
  return (
    <UsageCard source="opencode" title="OpenCode">
      <Segmented options={SEG_OPTIONS} value={days} onChange={onDays} label="OpenCode window" />
      <p className="usage-big">
        {win ? fmtTokens(win.tokens) : '—'}
        {win && typeof win.costUsd === 'number' && (
          <span className="usage-cost muted"> ≈ {fmtCost(win.costUsd)} est.</span>
        )}
      </p>
      <p className="usage-note muted">Consumption only — opencode-go exposes no plan limit.</p>
    </UsageCard>
  );
}

function AgyCard({
  a,
  days,
  onDays,
}: {
  a: UsageReport['agy'];
  days: number;
  onDays: (d: number) => void;
}) {
  if (!a.available) {
    return (
      <UsageCard source="agy" title="agy">
        <p className="usage-none muted">Unavailable{a.error ? ` — ${a.error}` : ''}</p>
      </UsageCard>
    );
  }
  const noRuns = a.windows.every((w) => (w.runs ?? 0) === 0);
  const win = a.windows.find((w) => w.days === days);
  return (
    <UsageCard source="agy" title="agy">
      <Segmented options={AGY_OPTIONS} value={days} onChange={onDays} label="agy window" />
      {noRuns ? (
        <p className="usage-big usage-big-empty">
          {days === 1 ? 'No agy runs in the last day' : 'No agy runs this week'}
        </p>
      ) : (
        <>
          <p className="usage-big">{win ? fmtTokens(win.tokens) : '—'}</p>
          {win ? (
            <p className="usage-runs">
              {win.runs ?? 0} runs · {win.stopped ?? 0} stopped
            </p>
          ) : (
            <p className="usage-runs">—</p>
          )}
        </>
      )}
      <p className="usage-note muted">Consumption only — agy exposes no quota.</p>
    </UsageCard>
  );
}

export function UsagePanel({
  report,
  loading,
  onRefresh,
}: {
  report: UsageReport | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  // Selected windows per source live here (not in the cards) so they survive card remounts.
  const [daysBySource, setDaysBySource] = useState<Record<'opencode' | 'agy', number>>({
    opencode: 1,
    agy: 1,
  });
  if (!report) {
    return (
      <div className="usage">
        <p className="sr-only" aria-live="polite">
          {loading ? 'Loading usage…' : 'Usage unavailable.'}
        </p>
        <p className="muted">{loading ? 'Loading…' : 'Usage unavailable.'}</p>
      </div>
    );
  }
  const asOf = report.claude.asOf ?? report.opencode.asOf ?? report.agy.asOf;
  const asOfLabel = asOf ? fmtClockShort(asOf) : '';
  return (
    <div className="usage">
      <p className="sr-only" aria-live="polite">
        Usage updated
      </p>
      <div className="usage-grid">
        <ClaudeCard claude={report.claude} />
        <OpenCodeCard
          oc={report.opencode}
          days={daysBySource.opencode}
          onDays={(d) => setDaysBySource((p) => ({ ...p, opencode: d }))}
        />
        <AgyCard
          a={report.agy}
          days={daysBySource.agy}
          onDays={(d) => setDaysBySource((p) => ({ ...p, agy: d }))}
        />
      </div>
      <div className="usage-foot">
        {asOfLabel ? <span className="usage-asof muted">as of {asOfLabel}</span> : null}
        <button
          type="button"
          className="icon-btn usage-refresh"
          aria-label="Refresh usage"
          aria-busy={loading || undefined}
          disabled={loading}
          title="Refresh"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}
