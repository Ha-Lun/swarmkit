// TopBar: session tabs. Left: the "swarmkit" brand as the Home button.
// Then one tab per running/waiting session plus the selected one (status dot, title,
// pending count, close button) and a final "+ New session" tab. Workers, Archive,
// usage and the connection state live in the StatusBar. On phones the tab row
// scrolls horizontally; close buttons are always visible on touch/narrow screens.
// The notifications bell sits after the tab row, outside it, so its popover is not clipped.
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { sessionHint } from './format';
import { PushBell } from './PushBell';

interface Props {
  sessions: SessionSummary[];
  selectedId: string | null;
  onHome: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: (id: string) => void;
  /** True while the tab's session has a live turn that needs a stop confirm. */
  isLivePage?: (s: SessionSummary) => boolean;
  /** Notifications bell; hidden when `pushEnabled` is false (mock/demo) or push is unsupported. */
  backend: FleetBackend;
  guard: Guard;
  pushEnabled: boolean;
}

function CloseConfirm({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <span
      className="top-tab-confirm"
      role="group"
      aria-label={`Close ${title}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <span>Stop session?</span>
      <button type="button" className="btn btn-danger btn-sm" onClick={onConfirm}>
        Stop
      </button>
      <button ref={cancelRef} type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
        Cancel
      </button>
    </span>
  );
}

export function TopBar({ sessions, selectedId, onHome, onSelect, onNew, onClose, isLivePage, backend, guard, pushEnabled }: Props) {
  const tabs = sessions.filter(
    (s) =>
      s.status === 'running' ||
      s.status === 'waiting' ||
      // A held terminal session (pane or not) stays tabbed: a pane-less one is
      // selected to be continued as a copy.
      (s.terminal !== undefined && s.status !== 'done' && s.status !== 'error' && s.status !== 'stopped') ||
      s.id === selectedId,
  );
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmingId === null) return;
    if (!tabs.some((t) => t.id === confirmingId)) setConfirmingId(null);
  });

  const cancelConfirm = () => {
    setConfirmingId(null);
    anchorRef.current?.focus();
  };

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
          const title = s.title || s.project;
          const live = isLivePage?.(s) ?? (s.status === 'running' || s.status === 'waiting');
          if (confirmingId === s.id && live) {
            return (
              <div key={s.id} className={`top-tab${selected ? ' is-selected' : ''}`}>
                <CloseConfirm
                  title={title}
                  onConfirm={() => {
                    setConfirmingId(null);
                    onClose(s.id);
                  }}
                  onCancel={cancelConfirm}
                />
              </div>
            );
          }
          return (
            <div key={s.id} className={`top-tab${selected ? ' is-selected' : ''}`}>
              <button
                type="button"
                className="top-tab-select"
                aria-current={selected ? 'page' : undefined}
                aria-label={`${sessionHint(s)}, status ${s.status}${
                  s.pendingPermissions > 0 ? `, ${s.pendingPermissions} pending` : ''
                }`}
                title={sessionHint(s)}
                onClick={() => onSelect(s.id)}
              >
                <i className={`dot st-${s.status}`} aria-hidden="true" />
                {s.terminal?.pane && (
                  <span
                    className={`top-tab-term${s.terminal.busy ? '' : ' is-idle'}`}
                    aria-hidden="true"
                    title="Terminal session"
                  >
                    &gt;_
                  </span>
                )}
                <span className="top-tab-title">{title}</span>
                {s.pendingPermissions > 0 && (
                  <span className="top-tab-pending" aria-hidden="true">
                    {s.pendingPermissions}
                  </span>
                )}
              </button>
              {s.terminal?.pane ? null : (
                <button
                  type="button"
                  className="top-tab-close"
                  aria-label={`Close ${title}`}
                  title={`Close ${title}`}
                  onClick={(e) => {
                    if (live) {
                      anchorRef.current = e.currentTarget;
                      setConfirmingId(s.id);
                    } else {
                      onClose(s.id);
                    }
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>
          );
        })}
        <button type="button" className="top-tab-new" aria-label="New session" onClick={onNew}>
          <span aria-hidden="true">+</span>
          <span className="top-tab-new-label">New session</span>
        </button>
      </nav>

      <PushBell backend={backend} guard={guard} enabled={pushEnabled} />
    </header>
  );
}
