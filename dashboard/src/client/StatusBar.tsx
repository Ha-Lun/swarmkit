// StatusBar: the one-line footer, as in the OpenCode TUI. Left: connection state, Workers
// and Archive buttons. Right: Claude and OpenCode Go usage meters (click for the full usage
// panel), then the dashboard version.
import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { SessionSummary, UsageLimit, UsageReport, WorkerTask } from '../shared/types';
import { version } from '../../package.json';
import { fmtResetIn, goPillModel, usageTone } from './format';
import { UsagePanel } from './Usage';

const pctOf = (u: number | null | undefined): number | null =>
  u == null || !Number.isFinite(u) ? null : Math.min(100, Math.max(0, Math.round(u)));

/** `Claude 5h [bar] 42% in 2h 10m`: label, a small bar, the percent and when it resets. */
function Meter({ label, pct, tone, reset, week }: { label: React.ReactNode; pct: number | null; tone: string; reset?: string; week?: boolean }) {
  return (
    <span className={`meter tone-${tone}${week ? ' meter-week' : ''}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-bar" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${pct ?? 0}%` }} />
      </span>
      <b>{pct == null ? '—' : `${pct}%`}</b>
      {reset ? <span className="meter-reset">{reset}</span> : null}
    </span>
  );
}

const limitReset = (l?: UsageLimit) => (l?.resetsAt ? fmtResetIn(l.resetsAt) : '');

interface Props {
  sessions: SessionSummary[];
  workers: WorkerTask[];
  connected: boolean;
  usage?: UsageReport;
  usageLoading: boolean;
  onRefreshUsage: () => void;
  onOpenWorkers: () => void;
  onOpenArchive: () => void;
}

export function StatusBar({ sessions, workers, connected, usage, usageLoading, onRefreshUsage, onOpenWorkers, onOpenArchive }: Props) {
  const runningWorkers = workers.filter((w) => w.state === 'running').length;
  const archived = sessions.filter((s) => s.resumable === true).length;

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const claude = usage?.claude.available === true ? usage.claude : undefined;
  const fiveHour = claude?.fiveHour;
  const sevenDay = claude?.sevenDay;
  const claudePct = pctOf(fiveHour?.utilization);
  const weekPct = pctOf(sevenDay?.utilization);
  const resetLabel = limitReset(fiveHour);
  const claudeLabel =
    claudePct == null
      ? undefined
      : `Claude 5-hour window ${claudePct}%${resetLabel ? `, resets ${resetLabel}` : ''}${weekPct == null ? '' : `; 7-day ${weekPct}%`}`;

  const go = goPillModel(usage?.opencode.limits);
  const goRolling = usage?.opencode.limits?.find((l) => l.window === 'rolling');
  // Antigravity workers run Gemini, so its 5-hour window is the one that stops them.
  const agyLimits = usage?.agy.available === true ? usage.agy.limits ?? [] : [];
  const agyLimit = agyLimits.find((l) => l.group === 'Gemini' && l.window === '5h') ?? agyLimits.find((l) => l.window === '5h');
  const agyPct = pctOf(agyLimit?.utilization);
  const agyReset = agyLimit?.resetsAt ? fmtResetIn(agyLimit.resetsAt) : '';
  const agyLabel = agyLimit ? `Antigravity ${agyLimit.group} 5-hour window ${agyPct ?? 'n/a'}%${agyReset ? `, resets ${agyReset}` : ''}` : undefined;
  const hasUsage = claudePct != null || go != null || agyLimit != null;

  return (
    <footer className="statusbar">
      <span className="status-conn" title={connected ? 'Live' : 'Reconnecting…'}>
        <i className={`dot ${connected ? 'st-done' : 'st-error'}`} aria-hidden="true" />
        <span className="status-conn-label">{connected ? 'connected' : 'reconnecting'}</span>
      </span>
      <nav className="status-nav" aria-label="Dashboard">
        <button type="button" className="status-btn" onClick={onOpenWorkers} aria-label={`Workers, ${runningWorkers} running`}>
          Workers <b title={`${runningWorkers} running`}>{runningWorkers}</b>
        </button>
        <button type="button" className="status-btn" onClick={onOpenArchive} aria-label={`Archive, ${archived} resumable`}>
          Archive <b title={`${archived} resumable ended sessions`}>{archived}</b>
        </button>
      </nav>
      <span className="status-spacer" />
      {hasUsage && (
        <div className="status-usage-wrap" ref={wrapRef}>
          <button
            type="button"
            className="status-btn status-usage"
            aria-expanded={open}
            aria-label={[claudeLabel, go?.label, agyLabel, 'Show usage details'].filter(Boolean).join('. ')}
            onClick={() => setOpen((o) => !o)}
          >
            {claudePct != null && (
              <Meter label={<>Claude<span className="meter-win"> 5h</span></>} pct={claudePct} tone={usageTone(fiveHour?.utilization ?? null)} reset={resetLabel} />
            )}
            {weekPct != null && <Meter week label="7d" pct={weekPct} tone={usageTone(sevenDay?.utilization ?? null)} />}
            {go && <Meter label="Go" pct={go.pct} tone={go.tone} reset={limitReset(goRolling)} />}
            {agyLimit && <Meter label="agy" pct={agyPct} tone={usageTone(agyLimit.utilization)} reset={agyReset} />}
          </button>
          {open && (
            <div className="usage-pop" role="dialog" aria-label="Usage">
              <UsagePanel report={usage ?? null} loading={usageLoading} onRefresh={onRefreshUsage} />
            </div>
          )}
        </div>
      )}
      <span className="status-ver" title="SwarmKit dashboard version">
        v{version}
      </span>
    </footer>
  );
}
