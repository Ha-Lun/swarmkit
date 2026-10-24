// Usage panel: Claude plan limits + opencode / agy consumption. Polled every 60s
// while the tab is visible; keeps the last good report through failures.
import { useCallback, useEffect, useState } from 'react';
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
  const [loading, setLoading] = useState(active);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const pull = (refresh?: boolean) => {
      guard(backend.usage(refresh))
        .then((r) => {
          if (alive && r) setReport(r);
        })
        .catch(() => undefined) // stale report stays; a 401 flips the UI via guard
        .finally(() => {
          if (alive) setLoading(false);
        });
    };
    pull();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') pull();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') pull();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active, backend, guard]);

  const refresh = useCallback(() => {
    if (!active) return;
    setLoading(true);
    guard(backend.usage(true))
      .then((r) => {
        if (r) setReport(r);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [active, backend, guard]);

  return { report, loading, refresh };
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
      <p className="usage-name">{title}</p>
      {children}
    </div>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ days: number; label: string }>;
  value: number;
  onChange: (days: number) => void;
}) {
  return (
    <div className="usage-seg" role="group" aria-label="Window">
      {options.map((o) => (
        <button
          key={o.days}
          type="button"
          aria-pressed={o.days === value || undefined}
          onClick={() => onChange(o.days)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function UsageBar({ label, limit }: { label: string; limit: UsageLimit }) {
  const u = limit.utilization;
  if (u == null) {
    return (
      <div className="usage-limit">
        <div className="usage-limit-top">
          <span className="usage-label">{label}</span>
          <span className="usage-pct muted">—</span>
        </div>
      </div>
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
      {limit.resetsAt && <p className="usage-reset muted">resets {fmtResetIn(limit.resetsAt)}</p>}
    </div>
  );
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

function OpenCodeCard({ oc }: { oc: UsageReport['opencode'] }) {
  const [days, setDays] = useState(1);
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
      <Segmented
        options={[
          { days: 1, label: '1d' },
          { days: 7, label: '7d' },
          { days: 30, label: '30d' },
        ]}
        value={days}
        onChange={setDays}
      />
      <p className="usage-big">
        {fmtTokens(win?.tokens ?? 0)}
        {typeof win?.costUsd === 'number' && (
          <span className="usage-cost muted"> ≈ {fmtCost(win.costUsd)} est.</span>
        )}
      </p>
      <p className="usage-note muted">Consumption only — opencode-go exposes no plan limit.</p>
    </UsageCard>
  );
}

function AgyCard({ a }: { a: UsageReport['agy'] }) {
  const [days, setDays] = useState(1);
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
      <Segmented
        options={[
          { days: 1, label: '1d' },
          { days: 7, label: '7d' },
        ]}
        value={days}
        onChange={setDays}
      />
      {noRuns ? (
        <p className="usage-big usage-big-empty">No agy runs this week</p>
      ) : (
        <>
          <p className="usage-big">{fmtTokens(win?.tokens ?? 0)}</p>
          <p className="usage-runs">
            {win?.runs ?? 0} runs · {win?.stopped ?? 0} stopped
          </p>
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
  if (!report) {
    return (
      <div className="usage" aria-live="polite">
        <p className="muted">{loading ? 'Loading…' : 'Usage unavailable.'}</p>
      </div>
    );
  }
  const asOf = report.claude.asOf ?? report.opencode.asOf ?? report.agy.asOf;
  return (
    <div className="usage">
      <div className="usage-grid">
        <ClaudeCard claude={report.claude} />
        <OpenCodeCard oc={report.opencode} />
        <AgyCard a={report.agy} />
      </div>
      <div className="usage-foot">
        <span className="usage-asof muted">as of {asOf ? fmtClockShort(asOf) : '—'}</span>
        <button
          type="button"
          className="icon-btn usage-refresh"
          aria-label="Refresh usage"
          title="Refresh"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      </div>
    </div>
  );
}
