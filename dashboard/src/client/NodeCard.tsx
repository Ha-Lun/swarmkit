// One agent pill. Pure display + permission panel slot; positioning handled by Tree.
// A matching WorkerTask (tree-linked worker) overlays its live data.
import type { KeyboardEvent } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { elapsedMs, fmtDuration, modelLabel, workerElapsedS, workerStateClass } from './format';
import { kindIcon } from './icons';
import { PermissionPanel } from './Permission';

interface Props {
  node: AgentNode;
  now: number;
  permission?: PermissionRequest;
  open: boolean;
  task?: WorkerTask;
  workersAt: number;
  onOpen: () => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string) => void;
  clickGuard: () => boolean;
}

function isFormTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return ['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName);
}

export function NodeCard({ node, now, permission, open, task, workersAt, onOpen, onDecide, clickGuard }: Props) {
  const isWorker = node.kind === 'worker' && node.worker;
  const name = isWorker ? `${node.worker!.lane} · ${node.worker!.slug}` : node.agentType;
  // Tool calls the user refused in the dashboard (workers report their own count via the task).
  const deniedCalls = task
    ? task.denied
    : node.events.filter((e) => e.kind === 'tool_result' && e.isError && /denied/i.test(e.summary)).length;

  // Live worker overlay when a WorkerTask matches this node.
  const model = task?.model ?? node.model;
  const activity = task?.lastTool ?? node.lastActivity;
  const elapsed = task ? workerElapsedS(task, now, workersAt) * 1000 : elapsedMs(node, now);
  const statusClass = task ? workerStateClass(task.state) : `st-${node.status}`;
  const statusLabel = task ? task.state : node.status;
  const isRunning = statusClass === 'st-running';
  const isWaiting = permission != null || statusClass === 'st-waiting';

  const ringClass = isRunning && !permission
    ? 'is-running'
    : isWaiting
      ? 'is-waiting'
      : statusClass === 'st-done'
        ? 'is-done'
        : statusClass === 'st-error'
          ? 'is-error'
          : 'is-idle';

  // Running shows the live activity with shimmer; otherwise the description (fall back to activity).
  const line2 = isRunning ? (activity ?? '') : (node.description ?? activity ?? '');
  const label = modelLabel(model);
  const ariaLabel = `${name}, ${label || 'no model'}, ${statusLabel}, ${fmtDuration(elapsed)}${deniedCalls > 0 ? `, ${deniedCalls} denied` : ''}`;

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isFormTarget(e.target)) {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      className={`node-card${permission ? ' is-waiting' : ''}${open ? ' is-open' : ''}`}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      onClick={() => {
        if (clickGuard()) return;
        onOpen();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="node-line1">
        <span className={`node-ring ${ringClass}`} aria-hidden="true">
          <span className="node-ring-core">{kindIcon(node.kind, 13)}</span>
        </span>
        <span className="node-name" title={name}>
          {name}
        </span>
        {label && <span className="node-model">{label}</span>}
      </div>

      <div className="node-line2">
        {line2 && (
          <span className={`node-activity${isRunning ? ' is-live' : ''}`} title={line2}>
            {line2}
          </span>
        )}
        <span className="node-meta">
          {deniedCalls > 0 && (
            <span className="node-denied" title={`${deniedCalls} tool calls denied`}>
              ⚠ {deniedCalls}
            </span>
          )}
          <span className="node-time">{fmtDuration(elapsed)}</span>
        </span>
      </div>

      {permission && (
        <PermissionPanel
          request={permission}
          onDecide={(allow, message) => onDecide(permission, allow, message)}
        />
      )}
    </div>
  );
}
