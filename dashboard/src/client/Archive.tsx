// Archive: ended sessions that can actually be continued (resumable === true),
// newest first, grouped by project. Ended sessions with resumable === false are not
// shown anywhere in the UI — only hidden, never deleted from disk.
import { useMemo, useState } from 'react';
import type { SessionSummary } from '../shared/types';
import { fmtCost, relTime } from './format';
import { TerminalIcon } from './icons';

interface Props {
  sessions: SessionSummary[];
  now: number;
  onSelect: (id: string) => void;
}

export function Archive({ sessions, now, onSelect }: Props) {
  const [filter, setFilter] = useState('');

  const archived = useMemo(
    () =>
      sessions
        .filter((s) => s.resumable === true)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  const q = filter.trim().toLowerCase();
  const visible = q
    ? archived.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.project.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q),
      )
    : archived;

  const groups = useMemo(() => {
    const out: Array<{ project: string; items: SessionSummary[] }> = [];
    for (const s of visible) {
      const name = s.project || 'unknown';
      const g = out.find((g) => g.project === name);
      if (g) g.items.push(s);
      else out.push({ project: name, items: [s] });
    }
    return out;
  }, [visible]);

  return (
    <div className="arch">
      <div className="arch-inner">
        <h1 className="arch-title">Archive</h1>
        <p className="muted arch-sub">
          Ended sessions you can continue. The session view already shows the Continue bar for them.
        </p>
        <input
          type="search"
          className="arch-filter"
          aria-label="Filter archived sessions"
          placeholder="Filter by title, project or folder…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {archived.length === 0 ? (
          <p className="arch-empty">No archived sessions.</p>
        ) : visible.length === 0 ? (
          <p className="arch-empty">No archived sessions match “{filter.trim()}”.</p>
        ) : (
          groups.map((g) => (
            <section key={g.project} aria-label={`Project ${g.project}`}>
              <h2 className="arch-group">{g.project}</h2>
              <div className="arch-list">
                {g.items.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className="arch-row"
                    onClick={() => onSelect(s.id)}
                    title={s.cwd}
                  >
                    <span className="arch-top">
                      <span className={`badge src-${s.source}`}>
                        {s.source === 'terminal' && <TerminalIcon size={10} />}
                        {s.source}
                      </span>
                      <span className="arch-name">{s.title || s.project}</span>
                      <span className="arch-cost">{fmtCost(s.costUsd)}</span>
                    </span>
                    <span className="arch-foot">
                      <span className="arch-cwd">{s.cwd}</span>
                      <span className="arch-when">ended {relTime(s.updatedAt, now)}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
