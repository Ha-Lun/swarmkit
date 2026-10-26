// Message composer for page sessions (terminal sessions get a read-only bar instead).
// Images ride along: paste, drag-drop or the paperclip; empty text is fine with images.
import { useEffect, useRef, useState } from 'react';
import type { ImageAttachment, SlashCommandInfo } from '../shared/types';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';
import { useEnterToSend } from './enterToSend';
import { useSlashMenu } from './SlashMenu';

interface Props {
  onSend: (text: string, images: ImageAttachment[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onStop: () => void;
  loadCommands: () => Promise<SlashCommandInfo[]>;
}

export function Composer({ onSend, onInterrupt, onStop, loadCommands }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments();

  const slash = useSlashMenu(text, setText, loadCommands, ref);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, onOk?: () => void) => {
    setError(null);
    try {
      await fn();
      onOk?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    }
  };

  const send = () => {
    const t = text.trim();
    const images = attachments.toPayload();
    if (!t && images.length === 0) return;
    void run(() => onSend(t, images), () => {
      setText('');
      attachments.clear();
    });
  };

  const canSend = text.trim().length > 0 || attachments.items.length > 0;

  // Slash menu wins over Enter: while it is open, Enter picks the command.
  const enterToSend = useEnterToSend(ref, send, { shouldSend: () => slash.menu == null });

  return (
    <div className="composer">
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
      {slash.menu}
      <div className="composer-box">
        <AttachDropzone onFiles={attachments.addFiles}>
          <textarea
            ref={ref}
            rows={1}
            aria-label="Message the session"
            placeholder="Message the session…"
            title="Enter to send, Shift+Enter for a new line"
            {...slash.inputProps}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              slash.onChange();
            }}
            onPaste={(e) => {
              const files = filesFromPaste(e);
              if (files.length > 0) attachments.addFiles(files);
            }}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (enterToSend.onKeyDown(e)) return;
            }}
          />
        </AttachDropzone>
        <div className="composer-actions">
          <AttachButton onFiles={attachments.addFiles} />
          <span className="composer-hint" aria-hidden="true">Enter to send · Shift+Enter for a new line</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(onInterrupt)}>
            Interrupt
          </button>
          <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onStop}>
            Stop
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={send}>
            Send
          </button>
        </div>
      </div>
      {(attachments.error || error) && (
        <p className="continue-error" role="alert">
          {attachments.error ?? error}
        </p>
      )}
    </div>
  );
}
