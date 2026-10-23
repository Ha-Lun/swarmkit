// One agent card. Pure display + permission panel slot; positioning handled by Tree.
// A matching WorkerTask (tree-linked worker) overlays its live data.
import type { KeyboardEvent } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { elapsedMs, fmtCost, fmtDuration, modelLabel, toolGroups, workerElapsedS, workerStateClass } from './format';
import { kindIcon, toolIcon } from './icons';
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
  const groups = toolGroups(node.toolCounts);
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
      onClick={() => {
        if (clickGuard()) return;
        onOpen();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="node-head">
        <span className={`node-kind k-${node.kind}`}>{kindIcon(node.kind)}</span>
        <span className="node-name" title={isWorker ? node.agentType : name}>
          {name}
        </span>
        {model && <span className="chip">{modelLabel(model)}</span>}
      </div>

      {groups.length > 0 && (
        <div className="node-tools" aria-label="Tool calls">
          {groups.map((g) => (
            <span key={g.key} className="tool" title={`${g.count} call${g.count === 1 ? '' : 's'}`}>
              {toolIcon(g.key)}
              <b>{g.count}</b>
            </span>
          ))}
        </div>
      )}

      {deniedCalls > 0 && <span className="chip wk-denied">{deniedCalls} denied</span>}

      {node.description && <p className="node-desc">{node.description}</p>}
      {activity && (
        <p className="node-activity" title={activity}>
          {activity}
        </p>
      )}

      <div className="node-foot">
        <span className="node-cost">
          {fmtCost(node.costUsd)}
          <i className="sep">·</i>
          {fmtDuration(elapsed)}
        </span>
        <span className={`node-status ${statusClass}`}>
          <i className="dot" aria-hidden="true" />
          {statusLabel}
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
