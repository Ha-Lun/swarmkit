// Reusable folder browser: current-folder box, breadcrumb, up, listing, hidden toggle, recents.
// Used by the landing card and the new-session dialog.
import { Fragment, useEffect, useState } from 'react';
import type { DirListing } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderIcon, StarIcon, UpIcon } from './icons';
import { useStars } from './stars';

const CWD_KEY = 'fleet.cwd';

export function loadStoredCwd(): string {
  try {
    return window.localStorage.getItem(CWD_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberCwd(path: string): void {
  try {
    window.localStorage.setItem(CWD_KEY, path);
  } catch {
    // private mode — selection still works, it just won't persist
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
  const [home, setHome] = useState('');
  const { stars, isStarred, toggle } = useStars(backend);

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

  // The server's default folder is $HOME: it anchors the "~" crumb.
  useEffect(() => {
    let alive = true;
    backend
      .dirs()
      .then((l) => {
        if (alive) setHome(l.path);
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
        if (!alive) return;
        if (!cwd.trim()) {
          setFailed(true);
          return;
        }
        // A remembered folder that no longer lists (moved, outside $HOME): fall back to the home folder.
        backend
          .dirs()
          .then((l) => {
            if (!alive) return;
            rememberCwd(l.path);
            onCwd(l.path);
          })
          .catch(() => {
            if (alive) setFailed(true);
          });
      });
    return () => {
      alive = false;
    };
    // onCwd is deliberately not a dependency: the parent passes a state setter.
  }, [cwd, hidden, reload, backend, guard]);

  const choose = (path: string) => {
    rememberCwd(path);
    onCwd(path);
  };

  const path = listing?.path ?? cwd;
  const visibleRecents = recents.filter((r) => !stars.includes(r));
  const underHome = home !== '' && (path === home || path.startsWith(`${home}/`));
  const rest = (underHome ? path.slice(home.length) : path).split('/').filter(Boolean);
  const crumbs = [
    ...(underHome ? [{ label: '~', path: home }] : []),
    ...rest.map((name, i) => ({
      label: name,
      path: `${underHome ? home : ''}/${rest.slice(0, i + 1).join('/')}`,
    })),
  ];

  return (
    <div className="fp" role="group" aria-labelledby={labelledby} aria-label={labelledby ? undefined : 'Working folder'}>
      <div className="fp-current" aria-live="polite">
        <FolderIcon size={15} />
        <code title={path}>{path || 'Loading folders…'}</code>
        {path !== '' && (
          <button
            type="button"
            className="star-btn"
            aria-pressed={isStarred(path)}
            aria-label={isStarred(path) ? 'Unstar this folder' : 'Star this folder'}
            onClick={() => toggle(path)}
          >
            <StarIcon size={15} filled={isStarred(path)} />
          </button>
        )}
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
          {crumbs.map((c, i) => (
            <Fragment key={`${i}-${c.path}`}>
              {i > 0 && (
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              )}
              <button
                type="button"
                className="crumb"
                aria-current={i === crumbs.length - 1 || undefined}
                onClick={() => choose(c.path)}
              >
                {c.label}
              </button>
            </Fragment>
          ))}
        </nav>
        <label className="fp-hidden">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Show hidden
        </label>
      </div>

      {stars.length > 0 && (
        <div className="fp-recents">
          <span className="fp-recents-label">Starred</span>
          {stars.map((s) => (
            <button key={s} type="button" className="fp-recent fp-starred" title={s} onClick={() => choose(s)}>
              {s.split('/').filter(Boolean).pop() ?? s}
            </button>
          ))}
        </div>
      )}

      {visibleRecents.length > 0 && (
        <div className="fp-recents">
          <span className="fp-recents-label">Recent</span>
          {visibleRecents.map((r) => (
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
            <li key={e.path} className={isStarred(e.path) ? 'fp-item is-starred' : 'fp-item'}>
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
              <button
                type="button"
                className="star-btn fp-row-star"
                aria-pressed={isStarred(e.path)}
                aria-label={isStarred(e.path) ? 'Unstar this folder' : 'Star this folder'}
                onClick={() => toggle(e.path)}
              >
                <StarIcon size={14} filled={isStarred(e.path)} />
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
