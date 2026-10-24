// Shared validation for session/message/resume bodies: length caps and id patterns.
// Throws ValidationError (status 400); HTTP and SDK layers map it to their own status errors.
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
