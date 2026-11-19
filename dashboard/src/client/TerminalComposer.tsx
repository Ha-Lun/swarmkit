// Message composer for a terminal session with a tmux pane: textarea + Send only.
// The server pastes the text into the pane and submits it with Enter; no attachments,
// interrupt, stop or Opus toggle here — the terminal session is not dashboard-owned.
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../shared/types';
import { MetaLine, PromptShell, providerName } from './Composer';
import { useEnterToSend } from './enterToSend';
import { modelLabel } from './format';
import { useSecretGuard } from './Secrets';

interface Props {
  session: SessionSummary;
  onSend: (text: string) => Promise<void>;
}

export function TerminalComposer({ session, onSend }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const secretGuard = useSecretGuard(session.cwd, session.id);
  // The registry says the claude process is mid-turn (or a prompt is up): refuse a send.
  const busyInTerminal = session.terminal?.busy === true || session.status === 'running' || session.status === 'waiting';
  const disabled = busy || busyInTerminal;

  const send = async (force = false) => {
    const t = text.trim();
    if (!t || disabled || sendingRef.current) return;
    if (!force && secretGuard.check(t)) return;
    sendingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSend(t);
      secretGuard.reset();
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send into the terminal.');
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  };

  const enterToSend = useEnterToSend(ref, () => {
    void send();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  return (
    <>
      <PromptShell
        runtime="claude"
        onFiles={() => { /* no attachments into a terminal pane */ }}
        tray={null}
        textarea={
          <textarea
            ref={ref}
            rows={1}
            aria-label="Message the terminal session"
            placeholder="Sends into your terminal session…"
            title="Enter to send, Shift+Enter for a new line"
            value={text}
            disabled={disabled}
            onChange={(e) => {
              setText(e.target.value);
              secretGuard.reset();
            }}
            onKeyDown={(e) => {
              if (enterToSend.onKeyDown(e)) return;
            }}
          />
        }
        meta={<MetaLine agent={session.agent} model={modelLabel(session.model)} provider={providerName('claude')} />}
        hint="enter send · shift+enter newline"
        error={
          <>
            {secretGuard.warning(() => text, () => {
              secretGuard.reset();
              void send(true);
            })}
            {error && (
              <p className="continue-error" role="alert">
                {error}
              </p>
            )}
          </>
        }
        left={
          <span className="composer-where">
            <span className="composer-where-path" title={session.cwd}>{session.project}</span>
          </span>
        }
        right={
          <>
            {busyInTerminal ? (
              <span className="continue-hint">busy in terminal</span>
            ) : (
              <span className="continue-hint">Sends into your terminal session</span>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={disabled || text.trim().length === 0} onClick={() => void send()}>
              {busy ? 'sending…' : 'send'}
            </button>
          </>
        }
      />
      {secretGuard.dialog}
    </>
  );
}
