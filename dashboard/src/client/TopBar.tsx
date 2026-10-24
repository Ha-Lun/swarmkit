// TopBar: the single slim sticky strip that replaces the sidebar. Left: the Logo
// with wordmark as the Home button. Center: a horizontally scrollable row of ACTIVE
// (running/waiting) session chips (omitted entirely when there are none). Right:
// Workers link, Archive link, the Claude 5h usage pill, a connection dot and the
// New session button — pinned to the right edge via margin-left: auto. No hamburger/sheet.
// On ≤768px the links collapse to 44×44 icon buttons with count badges, the usage
// pill and connection dot hide, and New session becomes a "+" icon button.
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import { fmtResetIn, usageTone } from './format';
import { ArchiveIcon, Logo, PlusIcon, WorkerIcon } from './icons';

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
        <button type="button" className="top-link" onClick={onOpenWorkers} aria-label={`Workers, ${runningWorkers} running`}>
          <span className="top-link-icon" aria-hidden="true">
            <WorkerIcon size={18} />
          </span>
          <span className="top-link-label">Workers</span>
          <span className="top-count" title={`${runningWorkers} running`} aria-hidden="true">
            {runningWorkers}
          </span>
        </button>
        <button type="button" className="top-link" onClick={onOpenArchive} aria-label={`Archive, ${archived} resumable`}>
          <span className="top-link-icon" aria-hidden="true">
            <ArchiveIcon size={18} />
          </span>
          <span className="top-link-label">Archive</span>
          <span className="top-count" title={`${archived} resumable ended sessions`} aria-hidden="true">
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
          className={`dot top-conn ${connected ? 'st-running' : 'st-error'}`}
          role="img"
          aria-label={connected ? 'Live' : 'Reconnecting'}
          title={connected ? 'Live' : 'Reconnecting…'}
        />
        <button type="button" className="btn btn-primary btn-sm top-new" onClick={onNew}>
          <PlusIcon size={13} />
          New session
        </button>
        <button type="button" className="icon-btn top-new-icon" onClick={onNew} aria-label="New session">
          <PlusIcon size={18} />
        </button>
      </nav>
    </header>
  );
}
