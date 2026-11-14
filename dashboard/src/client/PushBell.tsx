// PushBell: the notifications control in the top strip. A bell button opens a small popover
// to turn Web Push on for this device, pick which events notify, send a test and turn it off.
// Renders nothing where push cannot work (no service worker / insecure context) and in mock/demo.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PushEvents } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { BellIcon } from './icons';
import * as push from './push';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  /** False in mock/demo mode: the bell is hidden. */
  enabled: boolean;
}

type Phase = 'loading' | 'off' | 'on';
type Busy = 'enable' | 'test' | 'disable' | null;
interface Note {
  tone: 'ok' | 'error';
  text: string;
}

const EVENT_LABELS: { key: keyof PushEvents; label: string }[] = [
  { key: 'waiting', label: 'Needs you' },
  { key: 'finished', label: 'Finished' },
  { key: 'error', label: 'Errors' },
  { key: 'workers', label: 'Workers' },
];

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

function failureText(e: unknown): string {
  if (e instanceof push.PushPermissionError) return e.message;
  return e instanceof Error && e.message ? e.message : 'Something went wrong';
}

export function PushBell({ backend, guard, enabled }: Props) {
  if (!enabled || !push.pushSupported()) return null;
  return <PushPanel backend={backend} guard={guard} />;
}

function PushPanel({ backend, guard }: Omit<Props, 'enabled'>) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [events, setEvents] = useState<PushEvents>(push.DEFAULT_PUSH_EVENTS);
  const [perm, setPerm] = useState<NotificationPermission>(() => Notification.permission);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<Note | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();

  // Server state for this device. A browser subscription the server lost shows the enable
  // button again; enabling re-posts it.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const st = await guard(push.status(backend));
        if (!alive || !st) return;
        setPhase(st.browser && st.subscribed ? 'on' : 'off');
        setEvents(st.events);
      } catch {
        if (alive) setPhase('off');
      }
    })();
    return () => {
      alive = false;
    };
  }, [backend, guard]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrapRef.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Land focus on the first control when the popover opens.
  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open, phase]);

  const toggle = () => {
    setPerm(Notification.permission);
    setOpen((o) => !o);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close(true);
    }
  };

  const onBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !wrapRef.current?.contains(next)) setOpen(false);
  };

  // Called straight from the click: push.enable() must start requestPermission() inside the tap.
  const onEnable = async () => {
    setBusy('enable');
    setNote(null);
    try {
      const done = await guard(push.enable(backend, events).then(() => true));
      if (done) setPhase('on');
    } catch (e) {
      setPerm(Notification.permission);
      setNote({ tone: 'error', text: failureText(e) });
    } finally {
      setBusy(null);
      setPerm(Notification.permission);
    }
  };

  const onToggleEvent = async (key: keyof PushEvents) => {
    const previous = events;
    const next = { ...events, [key]: !events[key] };
    setEvents(next);
    setNote(null);
    try {
      await guard(push.updateEvents(backend, next));
    } catch (e) {
      setEvents((cur) => (cur === next ? previous : cur));
      setNote({ tone: 'error', text: failureText(e) });
    }
  };

  const onTest = async () => {
    setBusy('test');
    setNote(null);
    try {
      const result = await guard(push.sendTest(backend));
      if (result === 'ok') setNote({ tone: 'ok', text: 'Sent. It should arrive in a moment.' });
      else if (result === 'gone') {
        setPhase('off');
        setNote({ tone: 'error', text: 'This device was unsubscribed. Turn it on again.' });
      } else if (result === 'error') setNote({ tone: 'error', text: 'The push service did not accept it. Try again.' });
    } catch (e) {
      setNote({ tone: 'error', text: failureText(e) });
    } finally {
      setBusy(null);
    }
  };

  const onDisable = async () => {
    setBusy('disable');
    setNote(null);
    try {
      await guard(push.disable(backend));
      setPhase('off');
    } catch (e) {
      setNote({ tone: 'error', text: failureText(e) });
    } finally {
      setBusy(null);
    }
  };

  const blocked = perm === 'denied';
  const on = phase === 'on' && !blocked;

  return (
    <div className="push-wrap" ref={wrapRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        className={`push-bell${on ? ' is-on' : ''}`}
        aria-label={on ? 'Notifications, on for this device' : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={toggle}
      >
        <BellIcon size={16} />
      </button>
      {open && (
        <div ref={popRef} id={popId} className="push-pop" role="dialog" aria-label="Notifications on this device">
          {blocked ? (
            <p className="push-text">Blocked in browser settings. Allow notifications for this site there, then reopen this.</p>
          ) : phase === 'loading' ? (
            <p className="push-text" role="status">Checking this device…</p>
          ) : phase === 'off' ? (
            <>
              <p className="push-text">Get a notification when a session needs you, finishes or fails.</p>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy !== null}
                onClick={() => void onEnable()}
              >
                {busy === 'enable' ? 'Turning on…' : 'Notify me on this device'}
              </button>
            </>
          ) : (
            <>
              <fieldset className="push-events">
                <legend className="push-legend">Notify me when</legend>
                {EVENT_LABELS.map(({ key, label }) => (
                  <label key={key} className="push-check">
                    <input type="checkbox" checked={events[key]} onChange={() => void onToggleEvent(key)} />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <div className="push-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={() => void onTest()}
                >
                  {busy === 'test' ? 'Sending…' : 'Send test'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger-ghost btn-sm"
                  disabled={busy !== null}
                  onClick={() => void onDisable()}
                >
                  Turn off on this device
                </button>
              </div>
            </>
          )}
          <p className={`push-note${note ? ` is-${note.tone}` : ''}`} role="status">
            {note?.text}
          </p>
        </div>
      )}
    </div>
  );
}
