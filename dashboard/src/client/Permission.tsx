// Inline permission decision panel inside a node card.
import { useState } from 'react';
import type { PermissionRequest } from '../shared/types';
import { permissionSummary } from './format';
import { WarnIcon } from './icons';

interface Props {
  request: PermissionRequest;
  onDecide: (allow: boolean, message?: string) => void;
}

interface QuestionLike {
  question?: unknown;
  header?: unknown;
}

export function PermissionPanel({ request, onDecide }: Props) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);

  const isPlan = request.tool === 'ExitPlanMode';
  const isAsk = request.tool === 'AskUserQuestion';
  const plan = typeof request.input?.plan === 'string' ? (request.input.plan as string) : '';
  const questions = (Array.isArray(request.input?.questions) ? request.input.questions : []) as QuestionLike[];
  const questionText = (q: QuestionLike) => (typeof q.question === 'string' ? q.question : 'Question');

  const go = (allow: boolean, message?: string) => {
    if (busy) return;
    setBusy(true);
    onDecide(allow, message);
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
      ) : isAsk ? (
        <div className="perm-questions">
          {questions.map((q, i) => (
            <p key={i} className="perm-q">
              {questionText(q)}
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
        {isAsk ? (
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
