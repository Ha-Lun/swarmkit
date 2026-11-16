// PendingChat: the chat layout shown while a Claude start waits on the server's model triage, and
// again while the new session's first load is in flight. Same columns and bubbles as ChatView, so the
// real transcript replaces it in place; the thinking line is ChatView's own (scanner + shimmer label).
import type { CSSProperties } from 'react';
import { FileIcon } from './icons';
import { Scanner } from './Scanner';
import type { StartDraft } from './StartForm';

interface Props {
  draft: StartDraft;
  label: string;
}

export function PendingChat({ draft, label }: Props) {
  const { prompt, images, files } = draft;
  return (
    <div className="chat-wrap">
      <div className="chat" role="log" aria-live="polite">
        <div className="chat-col" style={{ '--lane': 'var(--rt-claude)' } as CSSProperties}>
          <div className="chat-user-block">
            {images.length > 0 && (
              <div className="chat-user-images">
                {images.map((src, i) => (
                  <span key={src} className="chat-user-thumb is-static">
                    <img src={src} alt={`Attached image ${i + 1}`} />
                  </span>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <ul className="chat-user-files" aria-label="Attached files">
                {files.map((name, i) => (
                  <li key={`${i}-${name}`} className="chat-user-file" title={name}>
                    <FileIcon size={13} /> {name}
                  </li>
                ))}
              </ul>
            )}
            {prompt && <p className="chat-user">{prompt}</p>}
          </div>
          <div className="chat-thinking" role="status">
            <Scanner size="sm" state="solving" color="var(--rt-claude)" />
            <span className="chat-thinking-label">{label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
