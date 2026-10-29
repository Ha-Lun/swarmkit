// Map entries for one agent: a full card (running / needs attention / root) and a compact
// one-line row (done). Pure display + permission panel slot; layout lives in Tree.
// A matching WorkerTask (tree-linked worker) overlays its live data.
import type { KeyboardEvent } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { agentDescription, agentLabel, agentState } from './chat';
import type { AgentState } from './chat';
import { elapsedMs, fmtDuration, modelLabel, workerElapsedS } from './format';
import { PermissionPanel } from './Permission';

interface Props {
  node: AgentNode;
  now: number;
  permission?: PermissionRequest;
  open: boolean;
  task?: WorkerTask;
  workersAt: number;
  onOpen: () => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string, answers?: Record<string, string>) => void;
}

type RowProps = Omit<Props, 'permission' | 'onDecide'>;

const STATE_LABEL: Record<AgentState, string> = {
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  idle: 'Idle',
  error: 'Failed',
  stopped: 'Stopped',
};

function isFormTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return ['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName);
}

interface NodeView {
  name: string;
  lane?: 'agy' | 'opencode';
  state: AgentState;
  model: string;
  agent: string;
  description: string;
  activity: string;
  elapsed: number;
  denied: number;
  ariaLabel: string;
}

function nodeView(node: AgentNode, now: number, task: WorkerTask | undefined, workersAt: number, hasPermission: boolean): NodeView {
  const state = agentState(node, task, hasPermission);
  const isWorker = node.kind === 'worker' && node.worker != null;
  const name = isWorker ? node.worker!.slug : agentLabel(node);
  const description = agentDescription(node, task);
  const activity = task?.lastTool ?? node.lastActivity ?? '';
  const elapsed = task ? workerElapsedS(task, now, workersAt) * 1000 : elapsedMs(node, now);
  // Tool calls the user refused in the dashboard (workers report their own count via the task).
  const denied = task
    ? task.denied
    : node.events.filter((e) => e.kind === 'tool_result' && e.isError && /denied/i.test(e.summary)).length;
  const model = modelLabel(task?.model ?? node.model);
  const agent = node.kind === 'worker' ? (task?.agent ?? node.worker?.agent ?? '') : '';
  const lane = isWorker ? node.worker!.lane : undefined;
  const ariaLabel = [
    lane ? `${lane} ${name}` : name,
    model || 'no model',
    STATE_LABEL[state],
    fmtDuration(elapsed),
    denied > 0 ? `${denied} denied` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return {
    name,
    lane,
    state,
    model,
    agent,
    description,
    // The live line only adds information when it says something the description does not.
    activity: activity === description ? '' : activity,
    elapsed,
    denied,
    ariaLabel,
  };
}

/** Small status glyph: spinner while live, otherwise a distinct shape per state (never colour alone). */
function StateIcon({ state }: { state: AgentState }) {
  if (state === 'running') return <span className="agent-spinner" aria-hidden="true" />;
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (state) {
    case 'done':
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      );
    case 'stopped':
      return (
        <svg {...common}>
          <rect x="7" y="7" width="10" height="10" rx="1.5" />
        </svg>
      );
    case 'waiting':
      return (
        <svg {...common}>
          <path d="M9.5 6v12M14.5 6v12" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M6 12h12" />
        </svg>
      );
  }
}

function LaneBadge({ lane }: { lane: 'agy' | 'opencode' }) {
  return <span className={`badge lane-${lane}`}>{lane}</span>;
}

export function NodeCard({ node, now, permission, open, task, workersAt, onOpen, onDecide, root = false }: Props & { root?: boolean }) {
  const v = nodeView(node, now, task, workersAt, permission != null);
  const live = v.state === 'running' || v.state === 'waiting';
  const showActivity = v.activity !== '' && (live || v.state === 'error' || v.state === 'stopped');

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isFormTarget(e.target)) {
      e.preventDefault();
      onOpen();
    }
  };

  const meta = (
    <div className="agent-meta">
      {v.model && <span className="chip">{v.model}</span>}
      {v.agent && <span className="chip chip-agent">{v.agent}</span>}
      {v.denied > 0 && <span className="agent-denied" title={`${v.denied} tool calls denied`}>⚠ {v.denied} denied</span>}
      {(v.state === 'error' || v.state === 'stopped' || v.state === 'waiting') && (
        <span className="agent-state-label">{STATE_LABEL[v.state]}</span>
      )}
    </div>
  );

  return (
    <div
      className={`agent-card st-${v.state}${root ? ' is-root' : ''}${open ? ' is-open' : ''}`}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={v.ariaLabel}
      onClick={onOpen}
      onKeyDown={onKeyDown}
    >
      <div className="agent-top">
        <span className="agent-state" aria-hidden="true">
          <StateIcon state={v.state} />
        </span>
        <span className="agent-name">
          {v.lane && <LaneBadge lane={v.lane} />}
          <span className="agent-name-text">{v.name}</span>
        </span>
        {root && meta}
        <span className="agent-time">{fmtDuration(v.elapsed)}</span>
      </div>

      {!root && meta}
      {v.description && <p className="agent-desc" title={v.description}>{v.description}</p>}
      {showActivity && (
        <p className="agent-activity" title={v.activity}>
          {v.activity}
        </p>
      )}

      {permission && (
        <PermissionPanel
          key={permission.id}
          request={permission}
          onDecide={(allow, message, answers) => onDecide(permission, allow, message, answers)}
        />
      )}
    </div>
  );
}

/** One-line row for a finished agent: status dot, name, description, model, duration. */
export function NodeRow({ node, now, open, task, workersAt, onOpen }: RowProps) {
  const v = nodeView(node, now, task, workersAt, false);
  return (
    <button
      type="button"
      className={`agent-row st-${v.state}${open ? ' is-open' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={v.ariaLabel}
      onClick={onOpen}
    >
      <span className="agent-state" aria-hidden="true">
        <StateIcon state={v.state} />
      </span>
      <span className="agent-name">
        {v.lane && <LaneBadge lane={v.lane} />}
        <span className="agent-name-text">{v.name}</span>
      </span>
      <span className="agent-row-desc" title={v.description}>
        {v.description}
      </span>
      <span className="agent-row-model">{v.model}</span>
      <span className="agent-time">{fmtDuration(v.elapsed)}</span>
    </button>
  );
}
