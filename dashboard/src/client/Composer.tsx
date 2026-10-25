// Message composer for page sessions (terminal sessions get a read-only bar instead).
// Images ride along: paste, drag-drop or the paperclip; empty text is fine with images.
import { useEffect, useId, useRef, useState } from 'react';
import type { ImageAttachment, SlashCommandInfo } from '../shared/types';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';
import { matchCommands, SlashMenu } from './SlashMenu';

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

  // Slash menu state: opens on a leading `/` token, loads once per opening.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const reqRef = useRef(0);
  const wasOpenRef = useRef(false);
  const loadRef = useRef(loadCommands);
  loadRef.current = loadCommands;
  const rawId = useId();
  const menuId = `slash-${rawId.replace(/:/g, '')}`;

  const open = /^\/\S*$/.test(text) && !dismissed;
  const query = text.slice(1);
  const filtered = open ? matchCommands(commands, query) : [];
  const clamped = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const id = ++reqRef.current;
      setLoading(true);
      loadRef.current().then(
        (list) => {
          if (reqRef.current !== id) return;
          setCommands(list);
          setLoading(false);
        },
        () => {
          if (reqRef.current !== id) return;
          setCommands([]);
          setLoading(false);
        },
      );
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
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

  const pick = (c: SlashCommandInfo) => {
    setText(`/${c.name} `);
    setDismissed(true);
    ref.current?.focus();
  };

  const canSend = text.trim().length > 0 || attachments.items.length > 0;

  return (
    <div className="composer">
      <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
      {open && (
        <SlashMenu
          id={menuId}
          items={filtered}
          active={clamped}
          loading={loading || !wasOpenRef.current}
          onPick={pick}
          onHover={setActive}
        />
      )}
      <AttachDropzone onFiles={attachments.addFiles}>
        <textarea
          ref={ref}
          rows={1}
          aria-label="Message the session"
          placeholder="Message the session…"
          title="Enter to send, Shift+Enter for a new line"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-activedescendant={open && filtered.length > 0 ? `${menuId}-${clamped}` : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
            setActive(0);
          }}
          onPaste={(e) => {
            const files = filesFromPaste(e);
            if (files.length > 0) attachments.addFiles(files);
          }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (filtered.length > 0) setActive((a) => (a + 1) % filtered.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (filtered.length > 0) setActive((a) => (a - 1 + filtered.length) % filtered.length);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDismissed(true);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
                if (filtered.length > 0) {
                  e.preventDefault();
                  pick(filtered[clamped]);
                  return;
                }
                if (e.key === 'Tab') return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
      </AttachDropzone>
      <div className="composer-actions">
        <AttachButton onFiles={attachments.addFiles} />
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
      {(attachments.error || error) && (
        <p className="continue-error" role="alert">
          {attachments.error ?? error}
        </p>
      )}
    </div>
  );
}
