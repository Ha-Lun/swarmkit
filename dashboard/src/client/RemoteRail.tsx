// RemoteRail: pinned list of the always-on `claude remote-control` tmux panes. A column on
// the left on wide screens, a chip strip on narrow ones. Live panes link to their
// claude.ai environment; a stopped pane gets a Restart (tmux respawn-pane on the server).
import { useCallback, useEffect, useState } from 'react';
import type { RemoteControl } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { relTime } from './format';

const POLL_MS = 15_000;

interface Props {
  backend: FleetBackend;
  guard: Guard;
  now: number;
}

export function RemoteRail({ backend, guard, now }: Props) {
  const [list, setList] = useState<RemoteControl[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const restart = async (r: RemoteControl) => {
    setBusy(r.id);
    setError(null);
    try {
      await guard(backend.restartRemoteControl(r.id));
      // The pane needs a moment to print its Connected/Capacity lines.
      window.setTimeout(() => void load(), 2_500);
      await load();
    } catch (e) {
      setError(`${r.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (!list || list.length === 0) return null;
  const live = list.filter((r) => r.alive).length;

  return (
    <aside className="rc-rail" aria-label="Remote control sessions">
      <div className="rc-head">
        <span>Remote control</span>
        <span className="rc-count" title={`${live} of ${list.length} running`}>
          {live}/{list.length}
        </span>
      </div>
      <ul className="rc-list">
        {list.map((r) => {
          const title = [r.name, r.cwd, `tmux ${r.target}`].filter(Boolean).join('\n');
          const meta = r.alive
            ? r.sessions !== undefined
              ? `${r.sessions} session${r.sessions === 1 ? '' : 's'}`
              : 'running'
            : r.stoppedAt
              ? `stopped ${relTime(r.stoppedAt, now)}`
              : 'stopped';
          const body = (
            <>
              <i className={`rc-dot${r.alive ? ' is-live' : ''}`} aria-hidden="true" />
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
            <li key={r.id} className={`rc-item${r.alive ? '' : ' is-stopped'}`}>
              {r.alive && r.url ? (
                <a className="rc-main" href={r.url} target="_blank" rel="noreferrer" title={`${title}\nOpen in claude.ai`}>
                  {body}
                </a>
              ) : (
                <span className="rc-main" title={title}>
                  {body}
                </span>
              )}
              {!r.alive && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm rc-restart"
                  disabled={busy !== null}
                  onClick={() => void restart(r)}
                  aria-label={`Restart ${r.name}`}
                >
                  {busy === r.id ? '…' : 'Restart'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="rc-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
