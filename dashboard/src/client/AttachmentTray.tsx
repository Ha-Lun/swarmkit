// Thumbnail tray, attach (paperclip) button and drag-drop wrapper for pending images.
import { useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { filesFromDrop } from './attachments';
import type { PendingImage } from './attachments';
import './attachments.css';

interface TrayProps {
  items: PendingImage[];
  onRemove: (id: string) => void;
}

/** Row of 56px thumbnails with a remove button each; nothing when empty. */
export function AttachmentTray({ items, onRemove }: TrayProps) {
  if (items.length === 0) return null;
  return (
    <div className="attach-tray" role="list" aria-label="Attached images">
      {items.map((item, i) => (
        <div className="attach-thumb" role="listitem" key={item.id}>
          <img src={item.previewUrl} alt={item.name || `Attached image ${i + 1}`} />
          <button
            type="button"
            className="attach-remove"
            aria-label={`Remove image ${i + 1}`}
            title={`Remove image ${i + 1}`}
            onClick={() => onRemove(item.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

interface ButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** 📎 button opening a hidden file input (image/*, multiple). */
export function AttachButton({ onFiles, disabled }: ButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label="Attach images"
        title="Attach images (PNG, JPEG, GIF, WebP — up to 6)"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <span aria-hidden="true">📎</span>
        <span aria-hidden="true" className="attach-btn-label">Attach</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

interface DropProps {
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
}

/** Highlights while a drag hovers and forwards drops to onFiles. */
export function AttachDropzone({ onFiles, className, children }: DropProps) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = filesFromDrop(e);
    if (files.length > 0) onFiles(files);
  };

  return (
    <div
      className={['attach-drop', dragging ? 'is-dragging' : '', className ?? ''].filter(Boolean).join(' ')}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
    </div>
  );
}
