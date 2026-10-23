// Worker task drawer: every field, the response, and a log tail refreshed every 3s
// while the drawer is open and the worker is running.
import { useEffect, useRef, useState } from 'react';
import type { WorkerTask } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { fmtClock, fmtDuration, shortModel, workerElapsedS, workerStateClass } from './format';
import { CloseIcon } from './icons';

interface Props {
  task: WorkerTask;
  backend: FleetBackend;
  guard: Guard;
  now: number;
  at: number;
  onClose: () => void;
  onViewInTree: (sessionId: string, nodeId: string) => void;
}

function ViewInTreeButton({
  sessionId,
  nodeId,
  onViewInTree,
}: {
  sessionId: string;
  nodeId: string;
  onViewInTree: (sessionId: string, nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost"
      onClick={() => onViewInTree(sessionId, nodeId)}
    >
      View in tree
    </button>
  );
}

export function WorkerDrawer({ task, backend, guard, now, at, onClose, onViewInTree }: Props) {
  const [log, setLog] = useState<string[] | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Log tail: pull once now, then every 3s while open and running.
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const pull = () => {
      guard(backend.workerLog(task.lane, task.repo, task.slug))
        .then((r) => {
          if (alive && r) setLog(r.lines);
        })
        .catch(() => {
          if (alive) setLog(null);
        });
    };
    pull();
    if (task.state === 'running') timer = window.setInterval(pull, 3000);
    return () => {
      alive = false;
      if (timer) window.clearInterval(timer);
    };
  }, [task.lane, task.repo, task.slug, task.state, backend, guard]);

  // Keep the tail pinned to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const field = (label: string, value?: string | number) =>
    value === undefined || value === '' ? null : (
      <div className="wk-field">
        <span>{label}</span>
        <b>{value}</b>
      </div>
    );

  return (
    <aside className="drawer" role="dialog" aria-label={`Worker ${task.slug}`}>
      <header className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <p className="drawer-title">
            {task.lane} · {task.slug}
          </p>
          <p className="drawer-sub">
            <span className={`node-status ${workerStateClass(task.state)}`}>
              <i className="dot" aria-hidden="true" />
              {task.state}
            </span>
            {task.model && <span className="chip">{shortModel(task.model)}</span>}
            <span>{fmtDuration(workerElapsedS(task, now, at) * 1000)}</span>
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="icon-btn"
          aria-label="Close worker details"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>

      <div className="drawer-body">
        {task.sessionId != null && task.nodeId != null && (
          <ViewInTreeButton sessionId={task.sessionId} nodeId={task.nodeId} onViewInTree={onViewInTree} />
        )}

        <div className="wk-fields">
          {field('Repo', task.repo)}
          {field('Model', task.model)}
          {field('Agent', task.agent)}
          {field('Effort', task.effort)}
          {field('Branch', task.branch)}
          {field('Started', fmtClock(task.startedAt))}
          {task.endedAt && field('Ended', fmtClock(task.endedAt))}
          {field('Denied', task.denied > 0 ? task.denied : undefined)}
          {field('Changes', task.changes)}
          {field('Stopped by', task.stoppedBy)}
          {field('Last tool', task.lastTool)}
        </div>

        {task.warnings && task.warnings.length > 0 && (
          <section aria-label="Warnings">
            <h3>Warnings</h3>
            <ul className="wk-warnings">
              {task.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        {task.response && (
          <section aria-label="Response">
            <h3>Response</h3>
            <pre className="wk-response">{task.response}</pre>
          </section>
        )}

        <section aria-label="Log tail">
          <h3>Log</h3>
          {log === null ? (
            <p className="timeline-empty">No log available.</p>
          ) : (
            <pre className="wk-log" ref={logRef}>
              {log.join('\n')}
            </pre>
          )}
        </section>
      </div>
    </aside>
  );
}
