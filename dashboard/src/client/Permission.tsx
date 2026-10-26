// Inline permission decision panel inside a node card.
import { useMemo, useState } from 'react';
import type { PermissionRequest } from '../shared/types';
import { permissionSummary } from './format';
import { WarnIcon } from './icons';
import './permission.css';

interface Props {
  request: PermissionRequest;
  onDecide: (allow: boolean, message?: string, answers?: Record<string, string>) => void;
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

function parseAskQuestions(input: unknown): AskQuestion[] {
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
    for (const o of r.options.slice(0, 4)) {
      if (!o || typeof o !== 'object') continue;
      const or = o as Record<string, unknown>;
      if (typeof or.label !== 'string' || !or.label.trim()) continue;
      const description = typeof or.description === 'string' ? or.description : '';
      const opt: AskOption = { label: or.label, description };
      if (typeof or.preview === 'string' && or.preview) opt.preview = or.preview;
      options.push(opt);
    }
    if (options.length === 0) continue;
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

function answerFor(s: QuestionState): string {
  const parts = [...s.picked];
  const other = s.otherText.trim();
  if (s.otherOn && other) parts.push(other);
  return parts.join(', ');
}

export function PermissionPanel({ request, onDecide }: Props) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const isPlan = request.tool === 'ExitPlanMode';
  const isAsk = request.tool === 'AskUserQuestion';
  const plan = typeof request.input?.plan === 'string' ? (request.input.plan as string) : '';

  const askQuestions = useMemo(
    () => (isAsk ? parseAskQuestions(request.input) : []),
    [isAsk, request.input],
  );
  const usePicker = isAsk && askQuestions.length > 0;

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
      const text = answerFor(effective[i] ?? { picked: [], otherOn: false, otherText: '' });
      if (!text.trim()) return null;
      out[askQuestions[i]!.question] = text.trim();
    }
    return out;
  }, [usePicker, askQuestions, effective]);

  const go = (allow: boolean, message?: string, ans?: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    onDecide(allow, message, ans);
  };

  const submitPicker = () => {
    if (!answers) return;
    go(true, undefined, answers);
  };

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
          <pre>{plan || permissionSummary(request)}</pre>
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
          />
        </div>
      ) : (
        <p className="perm-summary" title={permissionSummary(request)}>
          {permissionSummary(request)}
        </p>
      )}

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
            onClick={() => go(false, answer.trim())}
          >
            Answer
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => go(true)}
            >
              {isPlan ? 'Approve' : 'Allow'}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => go(false, isPlan ? 'Plan rejected from the dashboard' : 'Denied from the dashboard')}
            >
              {isPlan ? 'Reject' : 'Deny'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
