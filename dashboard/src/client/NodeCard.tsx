// Canvas entries: a compact card per agent and the folded "Done (n)" node. Pure display plus
// the permission panel slot; position and pan/zoom live in Tree.
// A matching WorkerTask (tree-linked worker) overlays its live data.
import type { AgentNode, PermissionRequest, Status, WorkerTask } from '../shared/types';
import { agentDescription, agentLabel, agentState, doneNames, orbColor, orbState, type DoneGroup } from './chat';
import { elapsedMs, fmtDuration, modelLabel, workerElapsedS } from './format';
import { Orb } from './Orb';
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

const STATE_LABEL: Record<Status, string> = {
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  idle: 'Idle',
  error: 'Failed',
  stopped: 'Stopped',
};

interface NodeView {
  name: string;
  lane?: 'agy' | 'opencode';
  state: Status;
  model: string;
  agent: string;
  description: string;
  activity: string;
  elapsed: number;
  denied: number;
  ariaLabel: string;
}

/** Elapsed ms for a node; a matching worker task knows better than the tree node. */
export function nodeElapsedMs(node: AgentNode, now: number, task: WorkerTask | undefined, workersAt: number): number {
  return task ? workerElapsedS(task, now, workersAt) * 1000 : elapsedMs(node, now);
}

function nodeView(node: AgentNode, now: number, task: WorkerTask | undefined, workersAt: number, hasPermission: boolean): NodeView {
  const state = agentState(node, task, hasPermission);
  const isWorker = node.kind === 'worker' && node.worker != null;
  const name = isWorker ? node.worker!.slug : agentLabel(node);
  const description = agentDescription(node, task);
  const activity = task?.lastTool ?? node.lastActivity ?? '';
  const elapsed = nodeElapsedMs(node, now, task, workersAt);
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

/** Small status glyph for settled states: a distinct shape per state (never colour alone). Live cards show the orb. */
function StateIcon({ state }: { state: Status }) {
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
  // Live work shows what it is doing; finished and failed agents keep just the description.
  const showActivity = v.activity !== '' && live;
  const showState = v.state === 'error' || v.state === 'stopped' || v.state === 'waiting';
  const full = [v.description, v.activity].filter(Boolean).join('\n');

  return (
    <div className={`agent-card st-${v.state}${root ? ' is-root' : ''}${open ? ' is-open' : ''}`}>
      <div className="agent-top">
        <span className="agent-state" aria-hidden="true">
          {live ? (
            <Orb size={20} state={orbState(node, v.state === 'waiting')} color={orbColor(node, task)} />
          ) : (
            <StateIcon state={v.state} />
          )}
        </span>
        {/* The one open control; its ::after stretches over the card so a click anywhere opens the drawer. */}
        <button
          type="button"
          className="agent-name agent-open"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={v.ariaLabel}
          title={full || undefined}
          onClick={onOpen}
        >
          {v.lane && <LaneBadge lane={v.lane} />}
          <span className="agent-name-text">{v.name}</span>
        </button>
        <span className="agent-time">{fmtDuration(v.elapsed)}</span>
      </div>

      <div className="agent-meta">
        {v.model && <span className="chip">{v.model}</span>}
        {v.agent && <span className="chip chip-agent">{v.agent}</span>}
        {v.denied > 0 && <span className="agent-denied" title={`${v.denied} tool calls denied`}>⚠ {v.denied} denied</span>}
        {showState && <span className="agent-state-label">{STATE_LABEL[v.state]}</span>}
      </div>
      {v.description && <p className="agent-desc">{v.description}</p>}
      {showActivity && <p className="agent-activity">{v.activity}</p>}

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

const NAMES_SHOWN = 3;

/** The folded "Done (n)" node: one button that shows the finished children of a parent in place. */
export function DoneCard({ group, elapsed, onExpand }: { group: DoneGroup; elapsed: number; onExpand: () => void }) {
  const names = doneNames(group.members);
  const n = group.members.length;
  const shown = names.slice(0, NAMES_SHOWN).join(', ');
  const more = names.length > NAMES_SHOWN ? ` +${names.length - NAMES_SHOWN}` : '';
  const time = fmtDuration(elapsed);
  return (
    <div className="agent-card st-done is-group">
      <div className="agent-top">
        <span className="agent-state" aria-hidden="true">
          <StateIcon state="done" />
        </span>
        <button
          type="button"
          className="agent-name agent-open"
          aria-expanded="false"
          aria-label={`Done, ${n} agents, ${time}. Show them`}
          title={names.join(', ')}
          onClick={onExpand}
        >
          <span className="agent-name-text">Done ({n})</span>
        </button>
        <span className="agent-time">{time}</span>
      </div>
      <p className="agent-desc">{shown + more}</p>
    </div>
  );
}
