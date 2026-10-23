// Session list: narrow column on desktop, slide-over sheet on <=768px.
import type { SessionSummary } from '../shared/types';
import { fmtCost, relTime } from './format';
import { PlusIcon, TerminalIcon } from './icons';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  open: boolean;
  connected: boolean;
  now: number;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

export function Sidebar({ sessions, selectedId, open, connected, now, onSelect, onNew, onClose }: Props) {
  return (
    <nav className={`sidebar${open ? ' is-open' : ''}`} aria-label="Sessions">
      <div className="side-brand">
        <span className="brand-dot" aria-hidden="true" />
        Claude Fleet
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
            <button
              key={s.id}
              type="button"
              className={`sess${s.id === selectedId ? ' is-selected' : ''}`}
              onClick={() => onSelect(s.id)}
              aria-current={s.id === selectedId || undefined}
            >
              <span className="sess-top">
                <span className={`badge src-${s.source}`}>
                  {s.source === 'terminal' && <TerminalIcon size={10} />}
                  {s.source}
                </span>
                <span className="sess-project">{s.project}</span>
                {s.pendingPermissions > 0 && (
                  <span className="sess-pending" title={`${s.pendingPermissions} pending permission(s)`}>
                    {s.pendingPermissions}
                  </span>
                )}
                <span className={`dot st-${s.status}`} aria-hidden="true" />
              </span>
              <span className="sess-title">{s.title || s.project}</span>
              <span className="sess-meta">
                {relTime(s.updatedAt, now)} · {fmtCost(s.costUsd)}
              </span>
            </button>
          ))
        )}
      </div>

      <div className="side-foot">
        <span className={`dot ${connected ? 'st-running' : 'st-error'}`} aria-hidden="true" />
        {connected ? 'Live' : 'Reconnecting…'}
      </div>
    </nav>
  );
}
