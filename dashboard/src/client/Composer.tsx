// Message composer for page sessions (terminal sessions get a read-only bar instead).
import { useEffect, useRef, useState } from 'react';

interface Props {
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onStop: () => void;
}

export function Composer({ onSend, onInterrupt, onStop }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

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
    if (!t) return;
    void run(() => onSend(t), () => setText(''));
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        rows={1}
        aria-label="Message the session"
        placeholder="Message the session… (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(onInterrupt)}>
          Interrupt
        </button>
        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onStop}>
          Stop
        </button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim()} onClick={send}>
          Send
        </button>
      </div>
      {error && (
        <p className="continue-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
