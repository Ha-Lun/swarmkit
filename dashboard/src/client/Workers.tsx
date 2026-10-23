// Workers: sidebar section ("N/3 running" + compact rows) and the full main-area view.
// Live data comes from the workers.update SSE event and GET /api/workers.
import type { WorkerTask } from '../shared/types';
import { fmtDuration, shortModel, workerElapsedS, workerStateClass } from './format';
import { ChevronIcon, WorkerIcon } from './icons';

/** Default worker cap advertised by the server; just used for the "N/3 running" readout. */
const CAP = 3;

export function workerKey(t: WorkerTask): string {
  return `${t.lane}/${t.repo}/${t.slug}`;
}

interface SectionProps {
  workers: WorkerTask[];
  now: number;
  at: number;
  onOpen: (task: WorkerTask) => void;
  onOpenAll: () => void;
}

export function WorkersSection({ workers, now, at, onOpen, onOpenAll }: SectionProps) {
  const running = workers.filter((w) => w.state === 'running').length;
  const top = workers.slice(0, 5);
  return (
    <section className="wk-section" aria-label="Worker tasks">
      <header className="wk-head">
        <h2>Workers</h2>
        <span className="wk-count" title={`${running} running, cap ${CAP}`}>
          {running}/{CAP} running
        </span>
      </header>
      {top.length === 0 ? (
        <p className="wk-none muted">No worker tasks.</p>
      ) : (
        top.map((w) => (
          <button
            key={workerKey(w)}
            type="button"
            className="wk-row"
            onClick={() => onOpen(w)}
            aria-haspopup="dialog"
          >
            <span className={`badge lane-${w.lane}`}>{w.lane}</span>
            <span className="wk-slug">{w.slug}</span>
            <span className="wk-elapsed">{fmtDuration(workerElapsedS(w, now, at) * 1000)}</span>
            <i className={`dot ${workerStateClass(w.state)}`} aria-hidden="true" />
          </button>
        ))
      )}
      <button type="button" className="wk-all" onClick={onOpenAll}>
        All workers
        <ChevronIcon size={12} />
      </button>
    </section>
  );
}

function WorkerCard({
  task,
  now,
  at,
  onOpen,
}: {
  task: WorkerTask;
  now: number;
  at: number;
  onOpen: (t: WorkerTask) => void;
}) {
  return (
    <button type="button" className="node-card wk-card" onClick={() => onOpen(task)} aria-haspopup="dialog">
      <div className="node-head">
        <span className={`badge lane-${task.lane}`}>{task.lane}</span>
        <span className="node-name">{task.slug}</span>
        <span className={`node-status ${workerStateClass(task.state)}`}>
          <i className="dot" aria-hidden="true" />
          {task.state}
        </span>
      </div>
      <p className="wk-repo" title={task.repo}>
        {task.repo}
      </p>
      <div className="wk-meta">
        {task.model && <span className="chip">{shortModel(task.model)}</span>}
        {task.agent && <span className="chip">{task.agent}</span>}
        {task.denied > 0 && <span className="chip wk-denied">{task.denied} denied</span>}
      </div>
      {task.state === 'running' && task.lastTool && (
        <p className="node-activity" title={task.lastTool}>
          {task.lastTool}
        </p>
      )}
      <div className="node-foot">
        <span className="node-cost">
          {fmtDuration(workerElapsedS(task, now, at) * 1000)}
          {task.changes && (
            <>
              <i className="sep">·</i>
              {task.changes}
            </>
          )}
        </span>
        {task.stoppedBy && <span className="wk-stopped">stopped by {task.stoppedBy}</span>}
      </div>
    </button>
  );
}

interface ViewProps {
  workers: WorkerTask[];
  now: number;
  at: number;
  onOpen: (t: WorkerTask) => void;
}

export function WorkersView({ workers, now, at, onOpen }: ViewProps) {
  return (
    <div className="wk-view">
      {workers.length === 0 ? (
        <div className="wk-empty">
          <WorkerIcon size={22} />
          <p>No worker tasks right now.</p>
          <p className="muted">
            agy-task and opencode-task directories from your task roots stream in here live, running first.
          </p>
        </div>
      ) : (
        <div className="wk-grid">
          {workers.map((w) => (
            <WorkerCard key={workerKey(w)} task={w} now={now} at={at} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
