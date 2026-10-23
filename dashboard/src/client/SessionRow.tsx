// Shared session row: badge, project, pending chip, status dot, title and recency meta.
// Used by the sidebar list and the landing recent-sessions list.
import type { SessionSummary } from '../shared/types';
import { fmtCost, relTime } from './format';
import { TerminalIcon } from './icons';

interface Props {
  session: SessionSummary;
  now: number;
  selected?: boolean;
  onSelect: (id: string) => void;
}

export function SessionRow({ session: s, now, selected, onSelect }: Props) {
  return (
    <button
      type="button"
      className={`sess${selected ? ' is-selected' : ''}`}
      onClick={() => onSelect(s.id)}
      aria-current={selected || undefined}
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
  );
}
