// Project secrets: a dialog to add or delete them, plus the paste-guard warning that offers it
// when a chat message looks like it contains a credential. A value lives only in the form
// input's own state while typing; it is never kept in app state, storage or logs.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SecretsListResponse } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { relTime } from './format';
import { looksLikeSecret } from './secretGuard';

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_VALUE_BYTES = 8 * 1024;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Restart wiring for the session the dialog was opened from (only set for a live, restartable page session). */
export interface SecretsRestart {
  sessionId: string;
  /** A turn is running, so restarting asks first. */
  active: boolean;
  busy: boolean;
  error: string | null;
  onRestart: () => void;
}

interface SecretsContextValue {
  backend: FleetBackend;
  guard: Guard;
  restart?: SecretsRestart;
}

/** Provided once by App so composers and forms can open the dialog without threading the backend through. */
export const SecretsContext = createContext<SecretsContextValue | null>(null);

function KeyIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l9-9M16 7l3 3M14 9l2 2" />
    </svg>
  );
}

/** Uppercase as you type; spaces and hyphens become underscores, anything else not allowed is dropped. */
function cleanName(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

interface DialogProps {
  cwd: string;
  /** Set when opened from a live session, to offer its restart. */
  sessionId?: string;
  /** Text for the value field, e.g. the token the paste guard matched. */
  initialValue?: string;
  onClose: () => void;
}

export function SecretsDialog({ cwd, sessionId, initialValue = '', onClose }: DialogProps) {
  const ctx = useContext(SecretsContext);
  const dialogRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const askFocus = useRef(false);
  const [list, setList] = useState<SecretsListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState(initialValue);
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartAsked, setRestartAsked] = useState(false);

  const backend = ctx?.backend;
  const guard = ctx?.guard;
  const restart = ctx?.restart && ctx.restart.sessionId === sessionId ? ctx.restart : undefined;

  const refresh = useCallback(async () => {
    if (!backend || !guard) return;
    try {
      const res = await guard(backend.secrets(cwd));
      if (res) {
        setList(res);
        setLoadError(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load secrets.');
    }
  }, [backend, guard, cwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The confirm replaces the Restart button, so put focus back on it once it returns.
  useEffect(() => {
    if (!confirmRestart && askFocus.current) {
      askFocus.current = false;
      askRef.current?.focus();
    }
  }, [confirmRestart]);

  // Focus in on open, back on whatever opened the dialog on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  if (!backend || !guard) return null;

  const multiline = value.includes('\n');
  const tooBig = new TextEncoder().encode(value).length > MAX_VALUE_BYTES;
  const exists = list?.names.some((n) => n.name === name) ?? false;
  const canSave = NAME_RE.test(name) && value.length > 0 && !tooBig && !saving;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      // A 401 resolves undefined and flips the app to the token screen, so there is nothing to clear.
      await guard(backend.putSecret({ cwd, name, value }));
      setStatus(`Saved ${name}.`);
      setName('');
      setValue('');
      setShown(false);
      await refresh();
      nameRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the secret.');
    }
    setSaving(false);
  };

  const remove = async (target: string) => {
    setError(null);
    try {
      await guard(backend.deleteSecret({ cwd, name: target }));
      setStatus(`Deleted ${target}.`);
      await refresh();
      nameRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the secret.');
    }
  };

  const trap = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Never also close a dialog this one is stacked on.
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  const restartDone = restartAsked && restart != null && !restart.busy && !restart.error;
  const valueProps = {
    id: 'sd-value',
    value,
    autoComplete: 'off',
    spellCheck: false,
    'aria-describedby': 'sd-note',
    placeholder: 'Paste the value here',
    onChange: (e: { target: { value: string } }) => {
      setValue(e.target.value);
      setError(null);
    },
  };

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog secrets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-title"
        onKeyDown={trap}
      >
        <h2 id="sd-title">Secrets</h2>
        <p className="secrets-project">
          <span className="muted">Project</span> <code title={list?.project ?? cwd}>{list?.project ?? cwd}</code>
        </p>

        <ul className="secrets-list" aria-label="Saved secrets">
          {!list && !loadError && <li className="secrets-empty muted">Loading…</li>}
          {list?.names.length === 0 && <li className="secrets-empty muted">No secrets yet for this project.</li>}
          {list?.names.map((n) => (
            <li key={n.name} className="secrets-item">
              <code className="secrets-name">{n.name}</code>
              <span className="secrets-when muted">updated {relTime(n.updatedAt, Date.now())}</span>
              <button
                type="button"
                className="btn btn-sm btn-danger-ghost secrets-delete"
                aria-label={`Delete ${n.name}`}
                onClick={() => void remove(n.name)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
        {loadError && (
          <p className="dialog-error" role="alert">
            {loadError}
          </p>
        )}

        <form className="secrets-form" onSubmit={(e) => void save(e)}>
          <label htmlFor="sd-name">Name</label>
          <input
            id="sd-name"
            ref={nameRef}
            value={name}
            maxLength={64}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            placeholder="STRIPE_API_KEY"
            aria-describedby="sd-name-hint"
            onChange={(e) => {
              setName(cleanName(e.target.value));
              setError(null);
            }}
          />
          <p id="sd-name-hint" className="secrets-hint muted">
            Capital letters, digits and underscores, starting with a letter (A-Z, 0-9, _).
          </p>

          <label htmlFor="sd-value">Value</label>
          <div className="secrets-value">
            {multiline ? (
              <textarea {...valueProps} rows={4} className={shown ? undefined : 'is-masked'} />
            ) : (
              <input {...valueProps} type={shown ? 'text' : 'password'} />
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-pressed={shown}
              aria-label={shown ? 'Hide value' : 'Show value'}
              onClick={() => setShown((v) => !v)}
            >
              {shown ? 'Hide' : 'Show'}
            </button>
          </div>
          {tooBig && (
            <p className="dialog-error" role="alert">
              That value is over 8 KB.
            </p>
          )}

          <p id="sd-note" className="secrets-note">
            Agents get secrets as environment variables in new or restarted sessions. Values are never shown again.
          </p>

          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          <p className="sr-only" role="status" aria-live="polite">
            {status}
          </p>

          {restart && (
            <div className="secrets-restart">
              {confirmRestart ? (
                <span
                  className="restart-ctl-confirm"
                  role="group"
                  aria-label="Confirm restart"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      askFocus.current = true;
                      setConfirmRestart(false);
                    }
                  }}
                >
                  <span>Restart stops the current turn.</span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    autoFocus
                    onClick={() => {
                      setConfirmRestart(false);
                      setRestartAsked(true);
                      restart.onRestart();
                    }}
                  >
                    Restart
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      askFocus.current = true;
                      setConfirmRestart(false);
                    }}
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <span className="secrets-restart-text">
                    {restartDone ? 'Session restarted; it now sees your secrets.' : 'This session only sees new secrets after a restart.'}
                  </span>
                  <button
                    ref={askRef}
                    type="button"
                    className="btn btn-sm"
                    disabled={restart.busy}
                    onClick={() => {
                      if (restart.active) setConfirmRestart(true);
                      else {
                        setRestartAsked(true);
                        restart.onRestart();
                      }
                    }}
                  >
                    {restart.busy ? 'Restarting…' : 'Restart session'}
                  </button>
                </>
              )}
              {restart.error && (
                <span className="restart-ctl-error" role="alert" title={restart.error}>
                  Restart failed: {restart.error}
                </span>
              )}
            </div>
          )}

          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              {saving ? 'Saving…' : exists ? 'Replace secret' : 'Save secret'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

interface WarnProps {
  kind: string;
  onSave: () => void;
  onSendAnyway: () => void;
}

/** The paste-guard warning: sits in a composer's error slot. */
export function SecretWarning({ kind, onSave, onSendAnyway }: WarnProps) {
  return (
    <div className="secret-warn" role="alert">
      <p>This looks like a secret ({kind}). Save it as a secret instead of sending it in chat?</p>
      <div className="secret-warn-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={onSave}>
          Save as secret
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onSendAnyway}>
          Send anyway
        </button>
      </div>
    </div>
  );
}

/** Opens the Secrets dialog for `cwd`. Render `dialog` somewhere in the component. */
export function useSecretsDialog(cwd: string, sessionId?: string): { open: (prefill?: string) => void; dialog: ReactNode } {
  const [isOpen, setIsOpen] = useState(false);
  // A ref, not state: the prefill is read once when the dialog mounts, and cleared on close.
  const prefill = useRef('');
  const open = useCallback((token = '') => {
    prefill.current = token;
    setIsOpen(true);
  }, []);
  const close = useCallback(() => {
    prefill.current = '';
    setIsOpen(false);
  }, []);
  const dialog = isOpen ? <SecretsDialog cwd={cwd} sessionId={sessionId} initialValue={prefill.current} onClose={close} /> : null;
  return { open, dialog };
}

/**
 * Paste guard for one message box. `check(text)` is true when the text looks like a credential and
 * the send should stop; `warning` is the notice to render, `dialog` the Secrets dialog.
 * Only the kind of match is kept; the token is re-read from the text when the user saves it.
 */
export function useSecretGuard(cwd: string, sessionId?: string) {
  const [kind, setKind] = useState<string | null>(null);
  const secrets = useSecretsDialog(cwd, sessionId);
  const reset = useCallback(() => setKind(null), []);
  const check = useCallback((text: string): boolean => {
    const hit = looksLikeSecret(text);
    setKind(hit ? hit.kind : null);
    return hit !== null;
  }, []);
  return useMemo(
    () => ({
      check,
      reset,
      open: secrets.open,
      dialog: secrets.dialog,
      /** `getText` reads the box at click time; `sendAnyway` carries on past the guard. */
      warning: (getText: () => string, sendAnyway: () => void): ReactNode =>
        kind && (
          <SecretWarning
            kind={kind}
            onSave={() => secrets.open(looksLikeSecret(getText())?.token ?? '')}
            onSendAnyway={sendAnyway}
          />
        ),
    }),
    [check, reset, kind, secrets.open, secrets.dialog],
  );
}

/** Small "secrets" button for rows that already hold a folder, opening its dialog. */
export function SecretsButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="composer-action"
      disabled={disabled}
      aria-label="Secrets for this folder"
      title="Store API keys and tokens for this project"
      onClick={onClick}
    >
      <span className="btn-icon" aria-hidden="true"><KeyIcon /></span>
      <span className="btn-text">secrets</span>
    </button>
  );
}
