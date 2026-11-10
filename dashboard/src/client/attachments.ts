// Pending image and file attachments for the composer, continue and start forms.
// Pure helpers (fitWithin, checkFiles, checkOtherFiles) are DOM-free so vitest can cover them;
// the hook itself does canvas downscaling (images) and FileReader reads (files) in the browser.
import { useCallback, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_TOTAL_BYTES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGES } from '../shared/types';
import type { FileAttachment, ImageAttachment, ImageMediaType } from '../shared/types';

/** Long edge over this is downscaled on a canvas before sending. */
export const MAX_LONG_EDGE = 1568;

export const ACCEPTED_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

const ACCEPTED_SET: ReadonlySet<string> = new Set(ACCEPTED_TYPES);

/** Raw non-GIF files bigger than this are refused before decoding (downscaling handles the rest). */
const MAX_RAW_BYTES = 50 * 1024 * 1024;

/**
 * Payload media type after canvas re-encoding (which also strips EXIF/GPS):
 * PNG stays PNG, JPEG stays JPEG, WebP stays WebP. GIF is never re-encoded
 * so it keeps its own type when untouched; anything unknown falls back to
 * JPEG once resized. The `resized` flag is kept for compatibility but no
 * longer changes the result for the supported still types.
 */
export function outputType(fileType: string, resized: boolean): ImageMediaType {
  if (fileType === 'image/png') return 'image/png';
  if (fileType === 'image/jpeg') return 'image/jpeg';
  if (fileType === 'image/webp') return 'image/webp';
  if (!resized && ACCEPTED_SET.has(fileType)) return fileType as ImageMediaType;
  return 'image/jpeg';
}

export interface PendingImage {
  id: string;
  mediaType: ImageMediaType;
  /** Base64 without a `data:` prefix, ready for the API body. */
  data: string;
  /** Object URL for the thumbnail preview; revoked by clear()/remove(). */
  previewUrl: string;
  name: string;
}

export interface PendingFile {
  id: string;
  name: string;
  mediaType: string;
  /** Raw byte size, for the tray's human-size label. */
  size: number;
  /** Base64 without a `data:` prefix, ready for the API body. */
  data: string;
}

/** Minimal file shape so tests can exercise validation without DOM Files. */
export interface FileLike {
  type: string;
  size: number;
  name?: string;
}

export interface CheckResult {
  accepted: FileLike[];
  /** Combined message for everything rejected, or null when all is well. */
  error: string | null;
}

function label(f: FileLike, fallback: string): string {
  const name = (f.name ?? '').trim();
  return name || fallback;
}

/**
 * Pure mime/count/size gate. Keeps the first files that fit into the
 * remaining slots, rejects unknown types and oversized files with messages.
 */
export function checkFiles(files: FileLike[], existingCount: number): CheckResult {
  // The cap is shared with general file attachments (existingCount counts both).
  const slots = MAX_ATTACHMENTS - existingCount;
  const accepted: FileLike[] = [];
  const problems: string[] = [];
  if (slots <= 0) {
    return {
      accepted,
      error: files.length > 0 ? `You can attach at most ${MAX_IMAGES} images per message.` : null,
    };
  }
  files.forEach((f, i) => {
    if (accepted.length >= slots) {
      if (!problems.some((p) => p.startsWith('Only the first'))) {
        problems.push(
          `Only the first ${slots} image${slots === 1 ? '' : 's'} were kept — at most ${MAX_IMAGES} per message.`,
        );
      }
      return;
    }
    if (!ACCEPTED_SET.has(f.type)) {
      problems.push(`“${label(f, `image ${i + 1}`)}” is not a supported image (PNG, JPEG, GIF or WebP).`);
      return;
    }
    // GIFs are never resized, so the 5 MB cap applies up front. Anything else
    // shrinks on the canvas first — only refuse absurd raw sizes here so a big
    // screenshot still gets its chance after the downscale.
    if (f.type === 'image/gif' ? f.size > MAX_IMAGE_BYTES : f.size > MAX_RAW_BYTES) {
      problems.push(
        f.type === 'image/gif'
          ? `“${label(f, `image ${i + 1}`)}” is too large — the limit is 5 MB per image.`
          : `“${label(f, `image ${i + 1}`)}” is too large to process (over 50 MB).`,
      );
      return;
    }
    accepted.push(f);
  });
  return { accepted, error: problems.length > 0 ? problems.join(' ') : null };
}

/**
 * Pure count/size gate for general file attachments. existingCount is everything already
 * pending or in flight (images + files), so the combined cap holds across both trays.
 * Refuses files over MAX_FILE_BYTES and stops when the running decoded total would
 * exceed MAX_ATTACHMENT_TOTAL_BYTES.
 */
export function checkOtherFiles(files: FileLike[], existingCount: number): CheckResult {
  const slots = MAX_ATTACHMENTS - existingCount;
  const accepted: FileLike[] = [];
  const problems: string[] = [];
  if (slots <= 0) {
    return {
      accepted,
      error: files.length > 0 ? `You can attach at most ${MAX_ATTACHMENTS} images and files per message.` : null,
    };
  }
  let total = 0;
  files.forEach((f, i) => {
    if (accepted.length >= slots) {
      if (!problems.some((p) => p.startsWith('Only the first'))) {
        problems.push(
          `Only the first ${slots} file${slots === 1 ? '' : 's'} were kept — at most ${MAX_ATTACHMENTS} per message.`,
        );
      }
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      problems.push(`“${label(f, `file ${i + 1}`)}” is too large — the limit is ${MAX_FILE_BYTES / (1024 * 1024)} MB per file.`);
      return;
    }
    if (total + f.size > MAX_ATTACHMENT_TOTAL_BYTES) {
      problems.push(`“${label(f, `file ${i + 1}`)}” would push the attachments over the ${MAX_ATTACHMENT_TOTAL_BYTES / (1024 * 1024)} MB total limit.`);
      return;
    }
    total += f.size;
    accepted.push(f);
  });
  return { accepted, error: problems.length > 0 ? problems.join(' ') : null };
}

/** Scale (w, h) down so the long edge is at most max, keeping the aspect ratio. */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || !Number.isFinite(max) || max <= 0) {
    return { w: 0, h: 0 };
  }
  const long = Math.max(w, h);
  if (long <= max) return { w: Math.round(w), h: Math.round(h) };
  const scale = max / long;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Paste sources: clipboardData.files first, then items of kind 'file' (screenshots). */
export function filesFromPaste(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/** Drop sources: every file carried by the drag event. */
export function filesFromDrop(e: DragEvent): File[] {
  const dt = e.dataTransfer;
  if (!dt?.files || dt.files.length === 0) return [];
  return Array.from(dt.files);
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsDataURL(blob);
  });
}

function loadSize(file: File): Promise<{ w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file).then((bmp) => {
      const size = { w: bmp.width, h: bmp.height };
      bmp.close();
      return size;
    });
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(size);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

function canvasBlob(
  file: File,
  w: number,
  h: number,
  type: string,
  quality?: number,
): Promise<Blob> {
  return loadBitmapImage(file).then(
    (img) =>
      new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('no 2d context'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))),
          type,
          quality,
        );
      }),
  );
}

function loadBitmapImage(file: File): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

export interface UseAttachments {
  items: PendingImage[];
  files: PendingFile[];
  error: string | null;
  addFiles: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  removeFile: (id: string) => void;
  clear: () => void;
  toPayload: () => ImageAttachment[];
  toFiles: () => FileAttachment[];
}

/**
 * Pending images for one composer. addFiles validates (mime/count/size),
 * always re-encodes PNG/JPEG/WebP through a canvas (long edge capped at
 * MAX_LONG_EDGE) so EXIF/GPS metadata is stripped even when no downscale
 * is needed (PNG stays PNG, JPEG stays JPEG at 0.92, WebP stays WebP at
 * 0.92 falling back to JPEG when the browser cannot encode WebP; GIF is
 * never resized) and rejects anything still over MAX_IMAGE_BYTES.
 */
export function useAttachments(): UseAttachments {
  const [items, setItems] = useState<PendingImage[]>([]);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<PendingImage[]>([]);
  const filesRef = useRef<PendingFile[]>([]);
  const seq = useRef(0);
  /** Slots promised to in-flight addFiles work, so two quick pastes cannot overfill the tray. */
  const inFlight = useRef(0);
  const filesInFlight = useRef(0);
  itemsRef.current = items;
  filesRef.current = files;

  const pendingCount = (): number => itemsRef.current.length + filesRef.current.length + inFlight.current + filesInFlight.current;

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const found = prev.find((p) => p.id === id);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const clear = useCallback(() => {
    const prev = itemsRef.current;
    for (const p of prev) URL.revokeObjectURL(p.previewUrl);
    itemsRef.current = [];
    filesRef.current = [];
    setItems([]);
    setFiles([]);
    setError(null);
  }, []);

  const toPayload = useCallback(
    (): ImageAttachment[] => items.map((p) => ({ mediaType: p.mediaType, data: p.data })),
    [items],
  );

  const toFiles = useCallback(
    (): FileAttachment[] => files.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.data })),
    [files],
  );

  const addFiles = useCallback((input: FileList | File[]) => {
    const incoming = Array.from(input);
    if (incoming.length === 0) return;
    // Images keep the existing canvas path; everything else (PDFs, text, heic, svg,
    // empty types) becomes a general file attachment read as base64.
    const imageInputs = incoming.filter((f) => ACCEPTED_SET.has(f.type));
    const otherInputs = incoming.filter((f) => !ACCEPTED_SET.has(f.type));
    const gate = checkFiles(imageInputs, pendingCount());
    const problems: string[] = gate.error ? [gate.error] : [];
    // checkFiles enforces the GIF byte cap up front; other types are
    // re-checked after downscaling, so every mime-gated file proceeds.
    // Reserve the slots now: the async work below resolves after render,
    // when itemsRef would still be stale for a second quick paste.
    // Slots are shared with the file tray: at most MAX_ATTACHMENTS of both.
    const room = Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length - filesRef.current.length - inFlight.current - filesInFlight.current);
    const candidates = (gate.accepted as File[]).slice(0, room);
    if (candidates.length < gate.accepted.length) {
      problems.push(`You can attach at most ${MAX_ATTACHMENTS} images per message.`);
    }
    inFlight.current += candidates.length;
    const otherGate = checkOtherFiles(otherInputs, itemsRef.current.length + filesRef.current.length + inFlight.current + filesInFlight.current);
    if (otherGate.error) problems.push(otherGate.error);
    const otherCandidates = otherGate.accepted as File[];
    filesInFlight.current += otherCandidates.length;
    if (candidates.length === 0 && otherCandidates.length === 0) {
      inFlight.current = Math.max(0, inFlight.current - candidates.length);
      filesInFlight.current = Math.max(0, filesInFlight.current - otherCandidates.length);
      setError(problems.join(' ') || 'Those files could not be attached.');
      return;
    }
    void (async () => {
      const next: PendingImage[] = [];
      try {
        for (const file of candidates) {
          const name = file.name || 'pasted image';
          try {
            if (file.type === 'image/gif') {
              // GIF is kept as-is, never resized.
              if (file.size > MAX_IMAGE_BYTES) {
                problems.push(`“${name}” is too large — the limit is 5 MB per image.`);
                continue;
              }
              const url = await readAsDataUrl(file);
              const data = url.split(',', 2)[1] ?? '';
              if (!data) throw new Error('empty');
              next.push({
                id: `img-${Date.now().toString(36)}-${seq.current++}`,
                mediaType: 'image/gif',
                data,
                previewUrl: URL.createObjectURL(file),
                name,
              });
              continue;
            }
            const size = await loadSize(file);
            const target = fitWithin(size.w, size.h, MAX_LONG_EDGE);
            // Always re-encode stills through the canvas so EXIF/GPS bytes
            // never reach the server, even when no shrink is needed.
            let outType = outputType(file.type, true);
            let blob: Blob;
            if (outType === 'image/png') {
              blob = await canvasBlob(file, target.w, target.h, 'image/png');
            } else if (outType === 'image/webp') {
              try {
                const attempt = await canvasBlob(file, target.w, target.h, 'image/webp', 0.92);
                if (attempt.type === 'image/webp') {
                  blob = attempt;
                } else {
                  outType = 'image/jpeg';
                  blob = await canvasBlob(file, target.w, target.h, 'image/jpeg', 0.92);
                }
              } catch {
                outType = 'image/jpeg';
                blob = await canvasBlob(file, target.w, target.h, 'image/jpeg', 0.92);
              }
            } else {
              outType = 'image/jpeg';
              blob = await canvasBlob(file, target.w, target.h, 'image/jpeg', 0.92);
            }
            if (blob.size > MAX_IMAGE_BYTES) {
              problems.push(`“${name}” is still over 5 MB after downscaling.`);
              continue;
            }
            const url = await readAsDataUrl(blob);
            const data = url.split(',', 2)[1] ?? '';
            if (!data) throw new Error('empty');
            next.push({
              id: `img-${Date.now().toString(36)}-${seq.current++}`,
              mediaType: outType,
              data,
              previewUrl: URL.createObjectURL(blob),
              name,
            });
          } catch {
            problems.push(`“${name}” could not be read as an image.`);
          }
        }
      } finally {
        inFlight.current = Math.max(0, inFlight.current - candidates.length);
      }
      if (next.length > 0) {
        setItems((prev) => {
          // Belt-and-braces: never exceed the cap even if the tray changed
          // while this batch was decoding; revoke whatever does not fit.
          // The file tray shares the cap, so leave its items room.
          const slots = Math.max(0, MAX_ATTACHMENTS - filesRef.current.length - prev.length);
          const kept = next.slice(0, slots);
          const dropped = next.slice(slots);
          for (const p of dropped) URL.revokeObjectURL(p.previewUrl);
          if (dropped.length > 0) {
            problems.push(`You can attach at most ${MAX_ATTACHMENTS} images per message.`);
          }
          return [...prev, ...kept];
        });
      }
      setError(problems.length > 0 ? problems.join(' ') : null);
    })();
    if (otherCandidates.length > 0) {
      void (async () => {
        const next: PendingFile[] = [];
        try {
          for (const file of otherCandidates) {
            const name = file.name || 'file';
            try {
              const url = await readAsDataUrl(file);
              const data = url.split(',', 2)[1] ?? '';
              if (!data) throw new Error('empty');
              next.push({
                id: `file-${Date.now().toString(36)}-${seq.current++}`,
                name,
                mediaType: file.type || 'application/octet-stream',
                size: file.size,
                data,
              });
            } catch {
              problems.push(`“${name}” could not be read.`);
            }
          }
        } finally {
          filesInFlight.current = Math.max(0, filesInFlight.current - otherCandidates.length);
        }
        if (next.length > 0) {
          setFiles((prev) => {
            // Belt-and-braces: the image tray shares the cap, so leave its items room.
            const slots = Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length - prev.length);
            const kept = next.slice(0, slots);
            if (kept.length < next.length) {
              problems.push(`You can attach at most ${MAX_ATTACHMENTS} images and files per message.`);
            }
            return [...prev, ...kept];
          });
        }
        setError(problems.length > 0 ? problems.join(' ') : null);
      })();
    }
  }, []);

  return { items, files, error, addFiles, remove, removeFile, clear, toPayload, toFiles };
}
