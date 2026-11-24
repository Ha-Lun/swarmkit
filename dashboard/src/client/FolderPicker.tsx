// Reusable folder browser: current-folder box, breadcrumb, up, listing, hidden toggle, recents.
// Used by the landing card and the new-session dialog.
import { Fragment, useEffect, useRef, useState } from 'react';
import type { DirListing } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderIcon, StarIcon, UpIcon } from './icons';
import { useStars } from './stars';

const CWD_KEY = 'fleet.cwd';

/** Folder outline with a plus badge, local to the picker (icons.tsx is untouched). */
function NewFolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  );
}

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
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const newFolderBtnRef = useRef<HTMLButtonElement>(null);
  const { stars, toggle } = useStars(backend);

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

  const canList = listing !== undefined && !failed;

  // A new folder is made in the folder on screen: close the name row when that folder changes.
  useEffect(() => {
    setShowNew(false);
    setNewName('');
    setCreateError('');
  }, [listing?.path]);

  const openNew = () => {
    setNewName('');
    setCreateError('');
    setShowNew(true);
  };

  const cancelNew = () => {
    setShowNew(false);
    setNewName('');
    setCreateError('');
    setCreating(false);
    newFolderBtnRef.current?.focus();
  };

  const doCreate = async () => {
    if (!listing || creating) return;
    if (newName.trim().length === 0) return;
    setCreating(true);
    setCreateError('');
    try {
      const res = await guard(backend.mkdir(listing.path, newName));
      if (res) {
        setShowNew(false);
        setNewName('');
        setCreateError('');
        choose(res.path);
        newFolderBtnRef.current?.focus();
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : 'Could not create folder');
    } finally {
      setCreating(false);
    }
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
            aria-pressed={stars.includes(path)}
            aria-label={stars.includes(path) ? 'Unstar this folder' : 'Star this folder'}
            onClick={() => toggle(path)}
          >
            <StarIcon size={15} filled={stars.includes(path)} />
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
        <button
          type="button"
          ref={newFolderBtnRef}
          className="icon-btn"
          aria-label="New folder"
          title="New folder"
          disabled={!canList || creating}
          onClick={() => (showNew ? cancelNew() : openNew())}
        >
          <NewFolderIcon size={16} />
        </button>
        <label className="fp-hidden">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          Show hidden
        </label>
      </div>

      {showNew && (
        <div
          className="fp-new"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelNew();
            }
          }}
        >
          <input
            type="text"
            className="fp-new-input"
            autoFocus
            placeholder="Folder name"
            aria-label="Folder name"
            value={newName}
            readOnly={creating}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void doCreate();
              }
            }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={creating || newName.trim().length === 0}
            onClick={() => void doCreate()}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={creating} onClick={cancelNew}>
            Cancel
          </button>
          {createError && (
            <p className="fp-new-error" role="alert">
              {createError}
            </p>
          )}
        </div>
      )}

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
            <li key={e.path} className={stars.includes(e.path) ? 'fp-item is-starred' : 'fp-item'}>
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
                aria-pressed={stars.includes(e.path)}
                aria-label={stars.includes(e.path) ? 'Unstar this folder' : 'Star this folder'}
                onClick={() => toggle(e.path)}
              >
                <StarIcon size={14} filled={stars.includes(e.path)} />
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
