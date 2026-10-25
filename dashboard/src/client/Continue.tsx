// Continue (resume): textarea + Continue for ended sessions or terminal transcripts.
// A 409 shows the server's error message inline.
import { useState } from 'react';
import type { SessionSource } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';

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
  const attachments = useAttachments();

  const submit = async () => {
    const t = text.trim();
    const images = attachments.toPayload();
    if ((!t && images.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await guard(
        backend.resume(sessionId, { text: t, ...(images.length > 0 ? { images } : {}) }),
      );
      if (res) {
        attachments.clear();
        onResumed(res.sessionId);
      } else setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue this session.');
      setBusy(false);
    }
  };

  const canSend = text.trim().length > 0 || attachments.items.length > 0;

  return (
    <form
      className="composer continue"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
      <AttachDropzone onFiles={attachments.addFiles}>
        <textarea
          rows={1}
          aria-label="Continue this session"
          placeholder="Continue this session…"
          title="Enter to send, Shift+Enter for a new line"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = filesFromPaste(e);
            if (files.length > 0) attachments.addFiles(files);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </AttachDropzone>
      <div className="composer-actions">
        {ended && <span className="continue-hint muted">Session has ended; use Continue.</span>}
        {source === 'terminal' && <span className="continue-hint muted">Continuing makes it page-owned.</span>}
        <AttachButton onFiles={attachments.addFiles} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend || busy}>
          {busy ? 'Continuing…' : 'Continue'}
        </button>
      </div>
      {(attachments.error || error) && (
        <p className="continue-error" role="alert">
          {attachments.error ?? error}
        </p>
      )}
    </form>
  );
}
