// Workers: the full main-area view.
// Live data comes from the workers.update SSE event and GET /api/workers.
import type { WorkerTask } from '../shared/types';
import { fmtDuration, shortModel, workerElapsedS, workerStateClass } from './format';
import { WorkerIcon } from './icons';

export function workerKey(t: WorkerTask): string {
  return `${t.lane}/${t.repo}/${t.slug}`;
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
