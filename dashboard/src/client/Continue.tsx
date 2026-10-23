// Continue (resume): textarea + Continue for ended sessions or terminal transcripts.
// A 409 shows the server's error message inline.
import { useState } from 'react';
import type { SessionSource } from '../shared/types';
import type { FleetBackend, Guard } from './api';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  sessionId: string;
  source: SessionSource;
  onResumed: (sessionId: string) => void;
  /** Text carried over from the composer when the session turned out to be over. */
  initialText?: string;
  /** The server just refused a message because the session has ended. */
  ended?: boolean;
}

export function Continue({ backend, guard, sessionId, source, onResumed, initialText = '', ended = false }: Props) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await guard(backend.resume(sessionId, { text: t }));
      if (res) onResumed(res.sessionId);
      else setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue this session.');
      setBusy(false);
    }
  };

  return (
    <form
      className="composer continue"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        rows={1}
        aria-label="Continue this session"
        placeholder="Continue this session… (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        {ended && <span className="continue-hint muted">Session has ended; use Continue.</span>}
        {source === 'terminal' && <span className="continue-hint muted">Continuing makes it page-owned.</span>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || busy}>
          {busy ? 'Continuing…' : 'Continue'}
        </button>
      </div>
      {error && (
        <p className="continue-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
