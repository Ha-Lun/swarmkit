// Inline permission decision panel inside a node card.
import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import type { DecideOptions, PermissionRequest } from '../shared/types';
import { permissionSummary } from './format';
import { WarnIcon } from './icons';
import './permission.css';

const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

interface Props {
  request: PermissionRequest;
  /** The session's project is untrusted: plan approval offers manual mode only. */
  untrusted?: boolean;
  onDecide: (allow: boolean, message?: string, answers?: Record<string, string>, opts?: DecideOptions) => void;
}

interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskOption[];
}

interface QuestionState {
  picked: string[];
  otherOn: boolean;
  otherText: string;
}

const OTHER_KEY = '__other__';
const SKIP_MESSAGE = 'The user skipped the question';
const MAX_OPTIONS = 10;
const PLAN_REJECT_MESSAGE = 'The user rejected the plan; keep planning.';

/** Deny message sent to the model when the user rejects a plan, with optional feedback. */
export function planRejectMessage(feedback: string): string {
  const text = feedback.trim();
  return text ? `Keep planning. Feedback from the user: ${text}` : PLAN_REJECT_MESSAGE;
}

export interface PlanChoice {
  label: string;
  title: string;
  primary: boolean;
  mode?: DecideOptions['mode'];
}

export const PLAN_MODE_HINT = 'Manual: every tool asks. Accept edits: file edits go through, other tools ask. Auto: no prompts.';
export const UNTRUSTED_PLAN_NOTE = 'Untrusted project: mode stays manual.';

/** Approve buttons for a plan, in display order; manual is primary, and untrusted projects get manual only. */
export function planChoices(untrusted: boolean): PlanChoice[] {
  if (untrusted) {
    return [{ label: 'Approve', title: 'Approve and continue in manual mode: every tool asks', primary: true }];
  }
  return [
    { label: 'Approve · manual', title: 'Approve and continue in manual mode: every tool asks', primary: true },
    {
      label: 'Approve · accept edits',
      title: 'Approve and continue in accept-edits mode: file edits go through, other tools still ask',
      primary: false,
      mode: 'acceptEdits',
    },
    { label: 'Approve · auto mode', title: 'Approve and continue in auto mode: no per-tool prompts', primary: false, mode: 'auto' },
  ];
}

export function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== 'object') return [];
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  const out: AskQuestion[] = [];
  for (const raw of rawQuestions.slice(0, 4)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.question !== 'string' || !r.question.trim()) continue;
    if (!Array.isArray(r.options)) continue;
    const options: AskOption[] = [];
    for (const o of r.options.slice(0, MAX_OPTIONS)) {
      if (!o || typeof o !== 'object') continue;
      const or = o as Record<string, unknown>;
      if (typeof or.label !== 'string' || !or.label.trim()) continue;
      const description = typeof or.description === 'string' ? or.description : '';
      const opt: AskOption = { label: or.label, description };
      if (typeof or.preview === 'string' && or.preview) opt.preview = or.preview;
      options.push(opt);
    }
    // A question with no options at all is a text-only question; one whose options all failed to parse is dropped.
    if (options.length === 0 && r.options.length > 0) continue;
    const q: AskQuestion = {
      question: r.question,
      multiSelect: r.multiSelect === true,
      options,
    };
    if (typeof r.header === 'string' && r.header.trim()) q.header = r.header.trim().slice(0, 24);
    out.push(q);
    if (out.length >= 4) break;
  }
  return out;
}

export function answerFor(s: QuestionState): string {
  const other = s.otherText.trim();
  // "Other" checked with blank text is unanswered — even when options are picked.
  if (s.otherOn && !other) return '';
  const parts = [...s.picked];
  if (s.otherOn && other) parts.push(other);
  return parts.join(', ');
}

/** A text-only question (no options) is answered by its textarea alone; others by picks plus "Other". */
export function answerForQuestion(q: AskQuestion, s: QuestionState): string {
  return q.options.length === 0 ? s.otherText.trim() : answerFor(s);
}

/** Raw question texts for the free-text fallback (skips missing/empty strings). */
export function fallbackQuestionTexts(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const rawQuestions = (input as { questions?: unknown }).questions;
  if (!Array.isArray(rawQuestions)) return [];
  const out: string[] = [];
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') continue;
    const q = (raw as Record<string, unknown>).question;
    if (typeof q === 'string' && q.length > 0) out.push(q);
  }
  return out;
}

export function PermissionPanel({ request, untrusted = false, onDecide }: Props) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  // Synchronous double-submit guard: set before setBusy so a second click in
  // the same tick cannot slip through while `busy` is still false.
  const submittedRef = useRef(false);

  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const rejectBtnRef = useRef<HTMLButtonElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  // Prefer the server-provided kind; fall back to the tool name for older payloads.
  const kind = request.kind;
  const isPlan = kind ? kind === 'plan' : request.tool === 'ExitPlanMode';
  const isAsk = kind ? kind === 'question' : request.tool === 'AskUserQuestion';
  const plan = typeof request.input?.plan === 'string' ? (request.input.plan as string) : '';

  const askQuestions = useMemo(
    () => (isAsk ? parseAskQuestions(request.input) : []),
    [isAsk, request.input],
  );
  // Only use the picker when EVERY raw question parsed (1-4 total); otherwise
  // fall back to free text so no question is silently dropped.
  const rawCount = Array.isArray((request.input as { questions?: unknown } | undefined)?.questions)
    ? ((request.input as { questions: unknown[] }).questions.length)
    : -1;
  const usePicker = isAsk && rawCount >= 1 && rawCount <= 4 && askQuestions.length === rawCount;

  const [states, setStates] = useState<QuestionState[]>([]);
  const effective: QuestionState[] = useMemo(() => {
    if (!usePicker) return [];
    return askQuestions.map((_, i) => states[i] ?? { picked: [], otherOn: false, otherText: '' });
  }, [usePicker, askQuestions, states]);

  const ensureStates = (): QuestionState[] => {
    if (states.length === askQuestions.length) return states;
    const next = askQuestions.map((_, i) => states[i] ?? { picked: [], otherOn: false, otherText: '' });
    setStates(next);
    return next;
  };

  const answers = useMemo(() => {
    if (!usePicker) return null;
    const out: Record<string, string> = {};
    for (let i = 0; i < askQuestions.length; i++) {
      const text = answerForQuestion(askQuestions[i]!, effective[i] ?? { picked: [], otherOn: false, otherText: '' });
      if (!text.trim()) return null;
      out[askQuestions[i]!.question] = text.trim();
    }
    return out;
  }, [usePicker, askQuestions, effective]);

  const go = (allow: boolean, message?: string, ans?: Record<string, string>, opts?: DecideOptions) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setBusy(true);
    onDecide(allow, message, ans, opts);
  };

  const isTerminal = request.terminal === true;
  const answerInTerminal = () => go(false, undefined, undefined, { terminal: true });

  const submitPicker = () => {
    if (!answers) return;
    go(true, undefined, answers);
  };

  const fallbackTexts = useMemo(
    () => (!isAsk || usePicker ? [] : fallbackQuestionTexts(request.input)),
    [isAsk, usePicker, request.input],
  );

  const submitFallback = () => {
    const text = answer.trim();
    if (!text) return;
    if (fallbackTexts.length > 0) {
      const ans: Record<string, string> = {};
      for (const t of fallbackTexts) ans[t] = text;
      go(true, undefined, ans);
    } else {
      go(false, text);
    }
  };

  const openReject = () => {
    setRejecting(true);
    // Focus after the textarea mounts.
    requestAnimationFrame(() => feedbackRef.current?.focus());
  };

  const cancelReject = () => {
    setRejecting(false);
    setFeedback('');
    requestAnimationFrame(() => rejectBtnRef.current?.focus());
  };

  const sendFeedback = () => go(false, planRejectMessage(feedback));

  const setPicked = (qi: number, label: string, multi: boolean) => {
    const base = ensureStates();
    const next = base.map((s, i) => (i === qi ? { ...s, picked: [...s.picked] } : s));
    const s = next[qi]!;
    if (multi) {
      s.picked = s.picked.includes(label) ? s.picked.filter(l => l !== label) : [...s.picked, label];
    } else {
      s.picked = [label];
      s.otherOn = false;
    }
    setStates(next);
  };

  const setOtherOn = (qi: number, on: boolean, multi: boolean) => {
    const base = ensureStates();
    const next = base.map((s, i) => (i === qi ? { ...s } : s));
    const s = next[qi]!;
    s.otherOn = on;
    if (on && !multi) s.picked = [];
    setStates(next);
  };

  const setOtherText = (qi: number, text: string) => {
    const base = ensureStates();
    const next = base.map((s, i) => (i === qi ? { ...s, otherText: text } : s));
    setStates(next);
  };

  return (
    // Stop the card's click/keyboard handlers from opening the drawer.
    <div className="perm" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <p className="perm-title">
        <WarnIcon size={13} />
        <span>
          <b>{request.tool}</b>
          {request.title ? ` — ${request.title}` : ''}
        </span>
      </p>

      {isPlan ? (
        <div className="perm-plan" role="region" aria-label="Proposed plan" tabIndex={0}>
          {plan ? (
            <Suspense fallback={<pre className="perm-plan-raw">{plan}</pre>}>
              <Markdown className="perm-plan-md" text={plan} />
            </Suspense>
          ) : (
            <pre className="perm-plan-raw">{permissionSummary(request)}</pre>
          )}
        </div>
      ) : usePicker ? (
        <div className="perm-questions">
          {askQuestions.map((q, qi) => {
            const st = effective[qi] ?? { picked: [], otherOn: false, otherText: '' };
            const groupName = `perm-ask-${request.id}-${qi}`;
            const selectedPreview = !q.multiSelect
              ? (q.options.find(o => o.label === st.picked[0])?.preview ?? null)
              : null;
            return (
              <fieldset key={`${qi}-${q.question}`} className="perm-ask-q">
                <legend className="perm-ask-legend">
                  {q.header ? <span className="perm-ask-chip">{q.header}</span> : null}
                  <span className="perm-ask-text">{q.question}</span>
                </legend>
                {q.options.length === 0 ? (
                  <textarea
                    className="perm-answer"
                    aria-label={`Answer for: ${q.question}`}
                    placeholder="Type your answer…"
                    rows={2}
                    value={st.otherText}
                    onChange={(e) => setOtherText(qi, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
                        e.preventDefault();
                        submitPicker();
                      }
                    }}
                  />
                ) : (
                <div
                  className="perm-ask-opts"
                  role={q.multiSelect ? 'group' : 'radiogroup'}
                  aria-label={q.question}
                >
                  {q.options.map(opt => {
                    const checked = st.picked.includes(opt.label);
                    return (
                      <label key={opt.label} className="perm-ask-opt">
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={groupName}
                          value={opt.label}
                          checked={checked}
                          onChange={() => setPicked(qi, opt.label, q.multiSelect)}
                        />
                        <span className="perm-ask-opt-body">
                          <b>{opt.label}</b>
                          {opt.description ? <span>{opt.description}</span> : null}
                        </span>
                      </label>
                    );
                  })}
                  <div className={`perm-ask-opt${st.otherOn ? ' is-other-on' : ''}`}>
                    <label className="perm-ask-other-label">
                      <input
                        type={q.multiSelect ? 'checkbox' : 'radio'}
                        name={groupName}
                        value={OTHER_KEY}
                        checked={st.otherOn}
                        onChange={(e) => setOtherOn(qi, e.target.checked, q.multiSelect)}
                        aria-label="Other (custom answer)"
                      />
                      <b>Other</b>
                    </label>
                    {st.otherOn ? (
                      <textarea
                        className="perm-ask-other-input"
                        aria-label={`Custom answer for: ${q.question}`}
                        placeholder="Type a custom answer…"
                        rows={2}
                        value={st.otherText}
                        onChange={(e) => setOtherText(qi, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
                            e.preventDefault();
                            submitPicker();
                          }
                        }}
                      />
                    ) : null}
                  </div>
                </div>
                )}
                {selectedPreview ? (
                  <pre className="perm-ask-preview">{selectedPreview}</pre>
                ) : null}
              </fieldset>
            );
          })}
        </div>
      ) : isAsk ? (
        <div className="perm-questions">
          {(Array.isArray(request.input?.questions) ? request.input.questions : []).map((q, i) => (
            <p key={i} className="perm-q">
              {typeof (q as { question?: unknown }).question === 'string'
                ? (q as { question: string }).question
                : 'Question'}
            </p>
          ))}
          <textarea
            className="perm-answer"
            aria-label="Answer"
            placeholder="Type your answer…"
            rows={2}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as KeyboardEvent).isComposing) {
                e.preventDefault();
                submitFallback();
              }
            }}
          />
        </div>
      ) : (
        <p className="perm-summary" title={permissionSummary(request)}>
          {permissionSummary(request)}
        </p>
      )}

      {isTerminal && (
        <p className="perm-note">The terminal session is waiting for this answer.</p>
      )}

      {isPlan && rejecting ? (
        <div className="perm-feedback">
          <label className="perm-feedback-label" htmlFor={`perm-fb-${request.id}`}>
            What should change?
          </label>
          <textarea
            id={`perm-fb-${request.id}`}
            ref={feedbackRef}
            className="perm-answer"
            rows={3}
            value={feedback}
            disabled={busy}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelReject();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !(e.nativeEvent as KeyboardEvent).isComposing) {
                e.preventDefault();
                sendFeedback();
              }
            }}
          />
          <div className="perm-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={sendFeedback}>
              Send feedback
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={cancelReject}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
      <div className="perm-actions">
        {usePicker ? (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !answers}
              onClick={submitPicker}
            >
              Answer
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => go(false, SKIP_MESSAGE)}
            >
              Skip
            </button>
          </>
        ) : isAsk ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !answer.trim()}
            onClick={submitFallback}
          >
            Answer
          </button>
        ) : isPlan ? (
          <>
            <p className="perm-hint" id={`perm-modes-${request.id}`}>
              {untrusted ? UNTRUSTED_PLAN_NOTE : PLAN_MODE_HINT}
            </p>
            <div className="perm-choices" role="group" aria-label="Approve and continue in" aria-describedby={`perm-modes-${request.id}`}>
              {planChoices(untrusted).map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className={`btn ${c.primary ? 'btn-primary' : 'btn-ghost'} btn-sm`}
                  disabled={busy}
                  title={c.title}
                  onClick={() => (c.mode ? go(true, undefined, undefined, { mode: c.mode }) : go(true))}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="perm-choices">
              <button
                ref={rejectBtnRef}
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={openReject}
              >
                Reject with feedback
              </button>
              {isTerminal && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={answerInTerminal}>
                  Answer in terminal
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => go(true)}
            >
              Allow
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => go(false, 'Denied from the dashboard')}
            >
              Deny
            </button>
          </>
        )}
        {isTerminal && !isPlan && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={answerInTerminal}>
            Answer in terminal
          </button>
        )}
      </div>
      )}
    </div>
  );
}
