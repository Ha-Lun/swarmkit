// RemoteRail: pinned list of the running `claude remote-control` tmux panes. A column on
// the left on wide screens, a chip strip on narrow ones. Each opens its claude.ai link.
import { useCallback, useEffect, useState } from 'react';
import type { RemoteControl } from '../shared/types';
import type { FleetBackend, Guard } from './api';

const POLL_MS = 15_000;

interface Props {
  backend: FleetBackend;
  guard: Guard;
}

export function RemoteRail({ backend, guard }: Props) {
  const [list, setList] = useState<RemoteControl[] | null>(null);

  const load = useCallback(async () => {
    const next = await guard(backend.remoteControls()).catch(() => undefined);
    if (next) setList(next);
  }, [backend, guard]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  if (!list || list.length === 0) return null;

  return (
    <aside className="rc-rail" aria-label="Remote control sessions">
      <div className="rc-head">
        <span>Remote control</span>
        <span className="rc-count">{list.length}</span>
      </div>
      <ul className="rc-list">
        {list.map((r) => {
          const title = [r.name, r.cwd, `tmux ${r.target}`].filter(Boolean).join('\n');
          const meta =
            r.sessions !== undefined ? `${r.sessions} session${r.sessions === 1 ? '' : 's'}` : 'running';
          const body = (
            <>
              <i className="rc-dot is-live" aria-hidden="true" />
              <span className="rc-text">
                <span className="rc-name">{r.name}</span>
                <span className="rc-meta">
                  {r.cwd && <span className="rc-cwd">{r.cwd}</span>}
                  <span>{meta}</span>
                </span>
              </span>
            </>
          );
          return (
            <li key={r.id} className="rc-item">
              {r.url ? (
                <a className="rc-main" href={r.url} target="_blank" rel="noreferrer" title={`${title}\nOpen in claude.ai`}>
                  {body}
                </a>
              ) : (
                <span className="rc-main" title={title}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
