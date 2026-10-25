// Agent tabs above the chat: Main + one tab per live/waiting/lingering agent.
import type { WorkerTask } from '../shared/types';
import { elapsedMs, fmtDuration, modelLabel, workerElapsedS } from './format';
import { matchWorkerTask, orbColor, orbState } from './chat';
import type { AgentTab } from './chat';
import { Orb } from './Orb';

interface Props {
  tabs: AgentTab[];
  activeId: string;
  now: number;
  workers: WorkerTask[];
  workersAt: number;
  onSelect: (nodeId: string) => void;
}

function tabName(node: AgentTab['node']): string {
  if (node.kind === 'worker' && node.worker) return `${node.worker.lane} · ${node.worker.slug}`;
  return node.agentType;
}

export function AgentTabs({ tabs, activeId, now, workers, workersAt, onSelect }: Props) {
  const renderTab = (
    id: string,
    name: string,
    label: string,
    phase: AgentTab['phase'],
    active: boolean,
    waiting: boolean,
    elapsed: string,
    dot: React.ReactNode,
  ) => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={active}
      className={`agent-tab is-${phase}${waiting ? ' is-waiting' : ''}${phase === 'done' || phase === 'error' ? ' is-leaving' : ''}${active ? ' is-active' : ''}`}
      onClick={() => onSelect(id)}
    >
      <span className="agent-tab-dot" aria-hidden="true">
        {dot}
      </span>
      <span className="agent-tab-name">{name}</span>
      {label && <span className="chip">{label}</span>}
      {waiting && <span className="agent-tab-needs">needs you</span>}
      <span className="agent-tab-time">{elapsed}</span>
    </button>
  );

  return (
    <div className="agent-tabs" role="tablist" aria-label="Agents">
      {renderTab(
        'root',
        'Main',
        '',
        'live',
        activeId === 'root',
        false,
        '',
        <span className="agent-tab-check" aria-hidden="true">
          ✦
        </span>,
      )}
      {tabs.map(({ node, phase }) => {
        const task = matchWorkerTask(node, workers);
        const elapsed = task
          ? fmtDuration(workerElapsedS(task, now, workersAt) * 1000)
          : fmtDuration(elapsedMs(node, now));
        const waiting = phase === 'waiting';
        const dot =
          phase === 'live' || waiting ? (
            <Orb size={20} state={orbState(node, waiting)} color={orbColor(node, task)} />
          ) : phase === 'done' ? (
            <span className="agent-tab-check" aria-hidden="true">
              ✓
            </span>
          ) : (
            <span className="agent-tab-x" aria-hidden="true">
              ✕
            </span>
          );
        return renderTab(
          node.id,
          tabName(node),
          modelLabel(task?.model ?? node.model),
          phase,
          activeId === node.id,
          waiting,
          elapsed,
          dot,
        );
      })}
    </div>
  );
}
