// Model triage: Sonnet classifies a Claude start prompt into trivial/normal/hard and maps
// that level to the lead's start model and effort (only `level` comes from the model).
// The rubric leans hard (Opus) whenever the scope is unclear.
import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { QueryFn } from './sdk/sessions.ts';
import type { Runtime, TriageInfo, TriageLevel } from '../src/shared/types.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PROMPT_CHARS = 4_000;
const MAX_REASON_CHARS = 80;
const TRIAGE_MODEL = 'claude-sonnet-5-5';

const TRIAGE_INSTRUCTION =
  'You route requests for a coding-agent dashboard. Classify the request. ' +
  'trivial = one small, obvious step; ' +
  'normal = a few steps or files, clear approach and clear scope; ' +
  'hard = debugging an unknown cause, a new feature or behaviour change in an existing app (especially UI plus server), ' +
  'multi-file design or refactor, security or data-sensitive work. ' +
  'Vague or open-ended requests whose scope you cannot see (fix it, something broke, improve X, check this with no clear target) are hard. ' +
  'Rate what this message asks for now, not the work it might lead to later. ' +
  'A question or opinion about the code or a design (should we X?, is Y still needed?, what does Z do?) is normal, ' +
  'even when the topic is a big change; it is hard only if answering means debugging, or if it also asks you to make the change. ' +
  'When unsure between two levels, pick the higher one. ' +
  'Examples: a release or version bump is trivial; ' +
  'renaming a UI label is trivial; ' +
  'clearing up disk space on a server is normal; ' +
  'adding rate limiting or changing auth is hard. ' +
  'Reply with only JSON {"level":"trivial|normal|hard","reason":"<8 words"}.';

const LEVEL_ROUTE: Record<TriageLevel, { model: 'sonnet' | 'opus'; effort: 'medium' | 'high' }> = {
  trivial: { model: 'sonnet', effort: 'medium' },
  normal: { model: 'sonnet', effort: 'high' },
  hard: { model: 'opus', effort: 'high' },
};

export interface TriageResult {
  level: TriageLevel;
  model: 'sonnet' | 'opus';
  effort: 'medium' | 'high';
  reason: string;
  source: 'model' | 'fallback';
  ms: number;
}

export interface TriageOptions {
  queryFn?: QueryFn;
  timeoutMs?: number;
  signal?: AbortSignal;
  hasAttachments?: boolean;
}

function fallbackResult(reason: string, startedAt: number): TriageResult {
  return {
    level: 'hard',
    model: 'opus',
    effort: 'high',
    reason,
    source: 'fallback',
    ms: Math.max(0, Date.now() - startedAt),
  };
}

/** Extracts concatenated text from an SDK assistant message (blocks, string content, or text field). */
function extractAssistantText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string') return msg.text;
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

/** Parses `{level, reason}` from the first '{' to the last '}' and sanitises the reason. */
function parseTriageReply(raw: string): { level: TriageLevel; reason: string } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as { level?: unknown; reason?: unknown };
  if (record.level !== 'trivial' && record.level !== 'normal' && record.level !== 'hard') {
    return null;
  }
  const rawReason = typeof record.reason === 'string' ? record.reason : '';
  const reason = rawReason.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, MAX_REASON_CHARS);
  return { level: record.level, reason };
}

/** Builds the classification prompt sent to the triage model. */
function buildTriagePrompt(prompt: string, hasAttachments?: boolean): string {
  const clipped = prompt.slice(0, MAX_PROMPT_CHARS);
  const attachmentNote = hasAttachments ? ' The request has attachments.' : '';
  return `${TRIAGE_INSTRUCTION}${attachmentNote} Request: ${JSON.stringify(clipped)}`;
}

/** Classifies a start prompt with the triage model; never throws (falls back to Opus/high on any failure). */
export async function triage(prompt: string, opts?: TriageOptions): Promise<TriageResult> {
  const startedAt = Date.now();
  if (opts?.signal?.aborted) {
    return fallbackResult('', startedAt);
  }
  if (prompt === '(image)' || prompt === '(file)') {
    return fallbackResult('attachments only', startedAt);
  }

  const aborted = new AbortController();
  const onCallerAbort = () => aborted.abort();
  opts?.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => aborted.abort(), timeoutMs);
  timer.unref?.();

  // Race every iterator step against abort so a stuck stream cannot hang past timeoutMs.
  const abortPromise = new Promise<never>((_, reject) => {
    if (aborted.signal.aborted) reject(new Error('triage aborted'));
    else aborted.signal.addEventListener('abort', () => reject(new Error('triage aborted')), { once: true });
  });
  abortPromise.catch(() => {});

  const options: Options = {
    cwd: os.homedir(),
    model: TRIAGE_MODEL,
    effort: 'low',
    persistSession: false,
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    tools: [],
    canUseTool: async () => ({ behavior: 'deny', message: 'triage' }),
    maxTurns: 1,
    abortController: aborted,
  };

  let iter: AsyncIterator<unknown> | undefined;
  try {
    const qFn = opts?.queryFn ?? query;
    const stream = qFn({ prompt: buildTriagePrompt(prompt, opts?.hasAttachments), options });
    iter = stream[Symbol.asyncIterator]();

    let assistantText = '';
    let resultText = '';
    while (true) {
      const step = await Promise.race([iter.next(), abortPromise]);
      if (step.done) break;
      const msg = step.value as Record<string, unknown> | undefined;
      if (!msg || typeof msg !== 'object') continue;
      if (msg.type === 'assistant') {
        const text = extractAssistantText(msg);
        if (text) assistantText = text;
      } else if (msg.type === 'result') {
        if (msg.is_error === true) return fallbackResult('', startedAt);
        if (typeof msg.result === 'string' && msg.result) resultText = msg.result;
        break;
      }
    }

    const parsed = parseTriageReply(resultText || assistantText);
    if (!parsed) return fallbackResult('', startedAt);
    const route = LEVEL_ROUTE[parsed.level];
    return {
      level: parsed.level,
      model: route.model,
      effort: route.effort,
      reason: parsed.reason,
      source: 'model',
      ms: Math.max(0, Date.now() - startedAt),
    };
  } catch {
    return fallbackResult('', startedAt);
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onCallerAbort);
    aborted.abort();
    if (iter?.return) {
      void Promise.resolve(iter.return(undefined)).catch(() => {});
    }
  }
}

/**
 * Triages a validated start body when the runtime is Claude and no explicit model was chosen.
 * Replaces any client-sent effort with the triage-mapped effort; other cases pass through unchanged.
 */
export async function triageStartBody<
  T extends { runtime?: Runtime; model?: string; effort?: string; prompt: string; images?: unknown[]; files?: unknown[] },
>(body: T, opts?: TriageOptions): Promise<T & { triage?: TriageInfo }> {
  if ((body.runtime ?? 'claude') !== 'claude' || body.model) {
    return body;
  }
  const hasAttachments = Boolean((body.images && body.images.length > 0) || (body.files && body.files.length > 0));
  const res = await triage(body.prompt, { ...opts, hasAttachments });
  return {
    ...body,
    model: res.model,
    effort: res.effort,
    triage: {
      level: res.level,
      reason: res.reason,
      source: res.source,
    },
  } as T & { triage?: TriageInfo };
}
