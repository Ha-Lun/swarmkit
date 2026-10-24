// TopBar: the single slim sticky strip that replaces the sidebar. Left: the Logo
// with wordmark as the Home button. Center: a horizontally scrollable row of ACTIVE
// (running/waiting) session chips. Right: Workers link, Archive link, the Claude 5h
// usage pill, a connection dot and the New session button. No hamburger/sheet.
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import { fmtResetIn, usageTone } from './format';
import { Logo, PlusIcon } from './icons';

interface Props {
  sessions: SessionSummary[];
  workers: WorkerTask[];
  selectedId: string | null;
  connected: boolean;
  /** Shared with the landing panel; drives the compact Claude pill. */
  usage?: UsageReport;
  onHome: () => void;
  onSelect: (id: string) => void;
  onOpenWorkers: () => void;
  onOpenArchive: () => void;
  onNew: () => void;
}

export function TopBar({
  sessions,
  workers,
  selectedId,
  connected,
  usage,
  onHome,
  onSelect,
  onOpenWorkers,
  onOpenArchive,
  onNew,
}: Props) {
  const active = sessions.filter((s) => s.status === 'running' || s.status === 'waiting');
  const runningWorkers = workers.filter((w) => w.state === 'running').length;
  const archived = sessions.filter((s) => s.resumable === true).length;

  const fiveHour = usage?.claude.available === true ? usage.claude.fiveHour : undefined;
  const utilization = fiveHour?.utilization ?? null;
  const resetLabel = fiveHour?.resetsAt ? fmtResetIn(fiveHour.resetsAt) : '';
  const pill =
    fiveHour != null && utilization != null
      ? `Claude 5-hour window ${Math.min(100, Math.max(0, Math.round(utilization)))}%${
          resetLabel ? `, resets ${resetLabel}` : ''
        }`
      : undefined;

  return (
    <header className="topstrip">
      <button
        type="button"
        className="top-brand"
        aria-label="SwarmKit — go to the dashboard home"
        onClick={onHome}
      >
        <Logo size={22} withWordmark />
      </button>

      {active.length > 0 && (
        <div className="top-chips" role="group" aria-label="Active sessions">
          {active.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`tchip${s.id === selectedId ? ' is-selected' : ''}`}
              aria-current={s.id === selectedId || undefined}
              aria-label={`${s.title || s.project}, status ${s.status}${
                s.pendingPermissions > 0 ? `, ${s.pendingPermissions} pending` : ''
              }`}
              title={s.title || s.project}
              onClick={() => onSelect(s.id)}
            >
              <i className={`dot st-${s.status}`} aria-hidden="true" />
              <span className="tchip-title">{s.title || s.project}</span>
              {s.pendingPermissions > 0 && (
                <span
                  className="tchip-pending"
                  title={`${s.pendingPermissions} pending permission(s)`}
                >
                  {s.pendingPermissions}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <nav className="top-actions" aria-label="Dashboard">
        <button type="button" className="top-link" onClick={onOpenWorkers}>
          Workers
          <span className="top-count" title={`${runningWorkers} running`}>
            {runningWorkers}
          </span>
        </button>
        <button type="button" className="top-link" onClick={onOpenArchive}>
          Archive
          <span className="top-count" title={`${archived} resumable ended sessions`}>
            {archived}
          </span>
        </button>
        {pill && utilization != null && (
          <span
            className={`usage-pill tone-${usageTone(utilization)}`}
            aria-label={pill}
            title={resetLabel ? `resets ${resetLabel}` : undefined}
          >
            Claude 5h <b>{Math.min(100, Math.max(0, Math.round(utilization)))}%</b>
          </span>
        )}
        <span
          className={`dot ${connected ? 'st-running' : 'st-error'}`}
          role="img"
          aria-label={connected ? 'Live' : 'Reconnecting'}
          title={connected ? 'Live' : 'Reconnecting…'}
        />
        <button type="button" className="btn btn-primary btn-sm top-new" onClick={onNew}>
          <PlusIcon size={13} />
          New session
        </button>
      </nav>
    </header>
  );
}
