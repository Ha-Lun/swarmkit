// Reusable folder browser: current-folder box, breadcrumb, up, listing, hidden toggle, recents.
// Used by the landing card and the new-session dialog.
import { Fragment, useEffect, useState } from 'react';
import type { DirListing } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderIcon, UpIcon } from './icons';

const CWD_KEY = 'fleet.cwd';

export function loadStoredCwd(): string {
  try {
    return window.localStorage.getItem(CWD_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Last folder from localStorage ('fleet.cwd'), else the first recent cwd, else '' (home). */
export function resolveDefaultCwd(backend: FleetBackend): Promise<string> {
  const stored = loadStoredCwd();
  if (stored) return Promise.resolve(stored);
  return backend
    .cwds()
    .then((list) => list[0] ?? '')
    .catch(() => '');
}

interface Props {
  backend: FleetBackend;
  guard: Guard;
  /** Absolute path of the selected folder; '' means the server's default (home). */
  cwd: string;
  onCwd: (path: string) => void;
  /** id of an external label element describing this picker. */
  labelledby?: string;
}

export function FolderPicker({ backend, guard, cwd, onCwd, labelledby }: Props) {
  const [listing, setListing] = useState<DirListing | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    backend
      .cwds()
      .then((list) => {
        if (alive) setRecents(list.slice(0, 6));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend]);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    guard(backend.dirs(cwd.trim() || undefined, hidden))
      .then((l) => {
        if (!alive) return;
        setListing(l ?? undefined);
        setFailed(!l);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [cwd, hidden, reload, backend, guard]);

  const choose = (path: string) => {
    try {
      window.localStorage.setItem(CWD_KEY, path);
    } catch {
      // private mode — selection still works, it just won't persist
    }
    onCwd(path);
  };

  const path = listing?.path ?? cwd;
  const parts = path.split('/').filter(Boolean);
  const isHomeRoot = parts[0] === 'home';

  return (
    <div className="fp" role="group" aria-labelledby={labelledby} aria-label={labelledby ? undefined : 'Working folder'}>
      <div className="fp-current" aria-live="polite">
        <FolderIcon size={15} />
        <code title={path}>{path || 'Loading folders…'}</code>
        {path && <span className="fp-current-tag">Selected folder</span>}
      </div>

      <div className="fp-bar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Go up one folder"
          disabled={!listing?.parent}
          onClick={() => {
            if (listing?.parent) choose(listing.parent);
          }}
        >
          <UpIcon size={14} />
        </button>
        <nav className="crumbs" aria-label="Folder path">
          {parts.map((p, i) => (
            <Fragment key={`${i}-${p}`}>
              {i > 0 && (
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              )}
              <button
                type="button"
                className="crumb"
                aria-current={i === parts.length - 1 || undefined}
                onClick={() => choose(`/${parts.slice(0, i + 1).join('/')}`)}
              >
                {i === 0 && isHomeRoot && parts.length > 1 ? '~' : p}
              </button>
            </Fragment>
          ))}
        </nav>
        <label className="fp-hidden">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Show hidden
        </label>
      </div>

      {recents.length > 0 && (
        <div className="fp-recents">
          <span className="fp-recents-label">Recent</span>
          {recents.map((r) => (
            <button key={r} type="button" className="fp-recent" title={r} onClick={() => choose(r)}>
              {r.split('/').filter(Boolean).pop() ?? r}
            </button>
          ))}
        </div>
      )}

      {failed ? (
        <p className="fp-empty muted" role="alert">
          Couldn’t list this folder.{' '}
          <button type="button" className="linklike" onClick={() => setReload((n) => n + 1)}>
            Retry
          </button>
        </p>
      ) : (
        <ul className="fp-list" aria-label="Subfolders">
          {(listing?.entries ?? []).map((e) => (
            <li key={e.path}>
              <button
                type="button"
                className="fp-row"
                aria-current={e.path === path || undefined}
                onClick={() => choose(e.path)}
              >
                <FolderIcon size={14} />
                <span className="fp-name">{e.name}</span>
                {e.isGitRepo && <span className="badge">git</span>}
              </button>
            </li>
          ))}
          {listing && listing.entries.length === 0 && (
            <li>
              <p className="fp-empty muted">No subfolders here — use this folder as-is.</p>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
