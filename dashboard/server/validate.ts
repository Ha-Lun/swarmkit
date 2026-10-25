// Shared validation for session/message/resume bodies: length caps and id patterns.
// Throws ValidationError (status 400); HTTP and SDK layers map it to their own status errors.
import { RUNTIME_MODELS } from '../src/shared/types.ts';
import type { Runtime } from '../src/shared/types.ts';

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

/** Start agent for a runtime: Claude keeps AGENT_RE, others must be absent or 'lead-dev-hybrid'. */
export function validRuntimeAgent(runtime: Runtime, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (runtime === 'claude') {
    if (typeof raw !== 'string' || !AGENT_RE.test(raw)) {
      throw new ValidationError(`agent must match ${String(AGENT_RE)}`);
    }
    return raw;
  }
  if (raw !== 'lead-dev-hybrid') {
    throw new ValidationError("agent must be 'lead-dev-hybrid' for this runtime");
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
