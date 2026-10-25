// Shared validation for session/message/resume bodies: length caps and id patterns.
// Throws ValidationError (status 400); HTTP and SDK layers map it to their own status errors.
import { MAX_IMAGE_BYTES, MAX_IMAGES, RUNTIME_MODELS } from '../src/shared/types.ts';
import type { ImageAttachment, ImageMediaType, Runtime } from '../src/shared/types.ts';

export const MAX_TEXT = 100_000;
export const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MODEL_RE = /^(opus|sonnet|haiku|claude-[a-z0-9.-]{1,60})$/;

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
  }
}

/** Non-empty trimmed string of at most MAX_TEXT chars; label names the field in errors. */
export function validText(raw: unknown, label = 'text'): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  if (raw.length > MAX_TEXT) {
    throw new ValidationError(`${label} must be at most ${MAX_TEXT} characters`);
  }
  return raw;
}

/** Optional model id; undefined/null stays undefined, otherwise must match MODEL_RE. */
export function validModel(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !MODEL_RE.test(raw)) {
    throw new ValidationError("model must be 'opus', 'sonnet', 'haiku' or a 'claude-*' model id");
  }
  return raw;
}

/** Optional effort level; undefined/null stays undefined, otherwise must be one of the five levels. */
export function validEffort(raw: unknown): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && (raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'xhigh' || raw === 'max')) {
    return raw;
  }
  throw new ValidationError('effort must be one of low, medium, high, xhigh, max');
}

/** Session lead runtime; undefined/null stays 'claude', otherwise must be one of the three. */
export function validRuntime(raw: unknown): Runtime {
  if (raw === undefined || raw === null) return 'claude';
  if (raw === 'claude' || raw === 'opencode' || raw === 'agy') return raw;
  throw new ValidationError("runtime must be one of 'claude', 'opencode', 'agy'");
}

/** Start/resume model for a runtime: Claude keeps MODEL_RE, others must name a RUNTIME_MODELS entry. */
export function validRuntimeModel(runtime: Runtime, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (runtime === 'claude') return validModel(raw);
  if (typeof raw === 'string' && RUNTIME_MODELS[runtime].includes(raw)) return raw;
  throw new ValidationError(`model must be one of ${RUNTIME_MODELS[runtime].join(', ')}`);
}

/** Start agent: every runtime runs 'lead-dev-hybrid'; the field may be absent or exactly that. */
export function validRuntimeAgent(_runtime: Runtime, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw !== 'lead-dev-hybrid') {
    throw new ValidationError("agent must be 'lead-dev-hybrid'");
  }
  return raw;
}

/** Start/resume effort for a runtime: only claude and agy accept one. */
export function validRuntimeEffort(runtime: Runtime, raw: unknown): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  const effort = validEffort(raw);
  if (effort !== undefined && runtime === 'opencode') {
    throw new ValidationError('effort is not supported for the opencode runtime');
  }
  return effort;
}

/** Resume model guard for direct SDK callers (the HTTP layer already knows the session runtime):
 *  accepts Claude ids and any configured non-Claude runtime model. */
export function validResumeModel(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return validModel(raw);
  } catch {
    // A non-Claude model id: fine here, the HTTP layer enforces the per-runtime list.
  }
  if (typeof raw === 'string' && (RUNTIME_MODELS.opencode.includes(raw) || RUNTIME_MODELS.agy.includes(raw))) {
    return raw;
  }
  throw new ValidationError("model must be 'opus', 'sonnet', 'haiku', a 'claude-*' model id, or a configured runtime model");
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** True when the first bytes of the decoded image match its declared media type. */
function magicMatches(mediaType: ImageMediaType, head: Buffer): boolean {
  const starts = (bytes: number[], at = 0): boolean => bytes.every((b, i) => head[at + i] === b);
  switch (mediaType) {
    case 'image/png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return starts([0xff, 0xd8, 0xff]);
    case 'image/gif':
      return head.subarray(0, 6).toString('latin1') === 'GIF87a' || head.subarray(0, 6).toString('latin1') === 'GIF89a';
    case 'image/webp':
      return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  }
}

const MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Optional images of a message: undefined/null/[] stay undefined, otherwise at most MAX_IMAGES
 * of { mediaType, data } with strict base64, a decoded size of at most MAX_IMAGE_BYTES and
 * magic bytes that match the declared type. The error text never echoes image data.
 */
export function validImages(raw: unknown): ImageAttachment[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ValidationError('images must be an array');
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_IMAGES) throw new ValidationError(`at most ${MAX_IMAGES} images per message`);
  const out: ImageAttachment[] = [];
  raw.forEach((item: unknown, i) => {
    const label = `images[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ValidationError(`${label} must be an object`);
    }
    const { mediaType, data } = item as { mediaType?: unknown; data?: unknown };
    if (typeof mediaType !== 'string' || !MEDIA_TYPES.includes(mediaType)) {
      throw new ValidationError(`${label}.mediaType must be image/png, image/jpeg, image/gif or image/webp`);
    }
    if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      throw new ValidationError(`${label}.data must be base64 (no data: prefix)`);
    }
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    if ((data.length / 4) * 3 - padding > MAX_IMAGE_BYTES) {
      throw new ValidationError(`${label} is larger than ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`);
    }
    const type = mediaType as ImageMediaType;
    if (!magicMatches(type, Buffer.from(data.slice(0, 24), 'base64'))) {
      throw new ValidationError(`${label} does not look like ${mediaType}`);
    }
    out.push({ mediaType: type, data });
  });
  return out;
}

/** Message text: like validText, but blank text is allowed (and becomes "(image)") when images are attached. */
export function validMessageText(raw: unknown, images: ImageAttachment[] | undefined, label = 'text'): string {
  if (images && images.length > 0 && (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim().length === 0))) {
    return '(image)';
  }
  return validText(raw, label);
}
