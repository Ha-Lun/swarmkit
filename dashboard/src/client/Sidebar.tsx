// Session list: narrow column on desktop, slide-over sheet on <=768px.
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import { CloseIcon, Logo, PlusIcon } from './icons';
import { SessionRow } from './SessionRow';
import { WorkersSection } from './Workers';
import { fmtResetIn, usageTone } from './format';

interface Props {
  sessions: SessionSummary[];
  workers: WorkerTask[];
  selectedId: string | null;
  open: boolean;
  connected: boolean;
  now: number;
  workersAt: number;
  /** Shared with the landing panel; drives the compact Claude pill near the bottom. */
  usage?: UsageReport;
  onSelect: (id: string) => void;
  onHome: () => void;
  onOpenWorker: (task: WorkerTask) => void;
  onOpenWorkers: () => void;
  onNew: () => void;
  onClose: () => void;
}

export function Sidebar({
  sessions,
  workers,
  selectedId,
  open,
  connected,
  now,
  workersAt,
  usage,
  onSelect,
  onHome,
  onOpenWorker,
  onOpenWorkers,
  onNew,
  onClose,
}: Props) {
  const fiveHour = usage?.claude.available === true ? usage.claude.fiveHour : undefined;
  const utilization = fiveHour?.utilization ?? null;
  return (
    <nav className={`sidebar${open ? ' is-open' : ''}`} aria-label="Sessions">
      <div className="side-head">
        <button
          type="button"
          className="side-brand"
          aria-label="SwarmKit — go to the dashboard home"
          onClick={onHome}
        >
          <Logo size={22} withWordmark />
        </button>
        <button
          type="button"
          className="icon-btn side-close"
          aria-label="Close session list"
          onClick={onClose}
        >
          <CloseIcon size={16} />
        </button>
      </div>
      <div className="side-actions">
        <button type="button" className="btn btn-primary side-new" onClick={onNew}>
          <PlusIcon size={13} />
          New session
        </button>
      </div>

      <div className="sess-list">
        {sessions.length === 0 ? (
          <p className="sess-empty">
            No sessions yet. Start one to watch the agent tree grow.
          </p>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              now={now}
              selected={s.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>

      <WorkersSection
        workers={workers}
        now={now}
        at={workersAt}
        onOpen={onOpenWorker}
        onOpenAll={onOpenWorkers}
      />

      {utilization != null && (
        <div className="side-usage">
          <span
            className={`usage-pill tone-${usageTone(utilization)}`}
            title={fiveHour?.resetsAt ? `resets ${fmtResetIn(fiveHour.resetsAt)}` : undefined}
          >
            Claude 5h <b>{Math.round(Math.min(100, Math.max(0, utilization)))}%</b>
          </span>
        </div>
      )}

      <div className="side-foot">
        <span className={`dot ${connected ? 'st-running' : 'st-error'}`} aria-hidden="true" />
        {connected ? 'Live' : 'Reconnecting…'}
      </div>
    </nav>
  );
}
