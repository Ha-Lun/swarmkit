// TopBar: flat OpenCode-style session tabs. Left: the "swarmkit" brand as the Home button.
// Then one mono tab per running/waiting session plus the selected one (status dot, title,
// pending count) and a final "+ New session" tab. Workers, Archive, usage and the connection
// state live in the StatusBar. On phones the tab row scrolls horizontally.
import type { SessionSummary } from '../shared/types';
import { sessionHint } from './format';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onHome: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
}

export function TopBar({ sessions, selectedId, onHome, onSelect, onNew }: Props) {
  const tabs = sessions.filter(
    (s) => s.status === 'running' || s.status === 'waiting' || s.id === selectedId,
  );

  return (
    <header className="topstrip">
      <button
        type="button"
        className="top-brand"
        aria-label="SwarmKit — go to the dashboard home"
        onClick={onHome}
      >
        <span className="top-brand-mark" aria-hidden="true" />
        swarmkit
      </button>

      <nav className="top-tabs" aria-label="Sessions">
        {tabs.map((s) => {
          const selected = s.id === selectedId;
          return (
            <button
              key={s.id}
              type="button"
              className={`top-tab${selected ? ' is-selected' : ''}`}
              aria-current={selected ? 'page' : undefined}
              aria-label={`${sessionHint(s)}, status ${s.status}${
                s.pendingPermissions > 0 ? `, ${s.pendingPermissions} pending` : ''
              }`}
              title={sessionHint(s)}
              onClick={() => onSelect(s.id)}
            >
              <i className={`dot st-${s.status}`} aria-hidden="true" />
              <span className="top-tab-title">{s.title || s.project}</span>
              {s.pendingPermissions > 0 && (
                <span className="top-tab-pending" aria-hidden="true">
                  {s.pendingPermissions}
                </span>
              )}
            </button>
          );
        })}
        <button type="button" className="top-tab top-tab-new" onClick={onNew}>
          <span aria-hidden="true">+</span> New session
        </button>
      </nav>
    </header>
  );
}
