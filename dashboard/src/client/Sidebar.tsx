// Session list: narrow column on desktop, slide-over sheet on <=768px.
import type { SessionSummary, WorkerTask } from '../shared/types';
import { Logo, PlusIcon } from './icons';
import { SessionRow } from './SessionRow';
import { WorkersSection } from './Workers';

interface Props {
  sessions: SessionSummary[];
  workers: WorkerTask[];
  selectedId: string | null;
  open: boolean;
  connected: boolean;
  now: number;
  workersAt: number;
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
  onSelect,
  onHome,
  onOpenWorker,
  onOpenWorkers,
  onNew,
  onClose,
}: Props) {
  return (
    <nav className={`sidebar${open ? ' is-open' : ''}`} aria-label="Sessions">
      <button
        type="button"
        className="side-brand"
        aria-label="SwarmKit — go to the dashboard home"
        onClick={onHome}
      >
        <Logo size={22} withWordmark />
      </button>
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

      <div className="side-foot">
        <span className={`dot ${connected ? 'st-running' : 'st-error'}`} aria-hidden="true" />
        {connected ? 'Live' : 'Reconnecting…'}
      </div>
    </nav>
  );
}
