// Chat transcript for one agent: bubbles, tool rows, handoff cards, thinking indicator.
import { useLayoutEffect, useRef, useState } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { MAX_EVENTS } from '../shared/types';
import { buildChat, matchWorkerTask, orbColor, orbLabel, orbState } from './chat';
import type { ChatItem } from './chat';
import { elapsedMs, fmtDuration, modelLabel, toolGroups, workerElapsedS } from './format';
import type { ToolKey } from './format';
import { toolIcon } from './icons';
import { Markdown } from './Markdown';
import { Orb } from './Orb';
import { PermissionPanel } from './Permission';

interface Props {
  node: AgentNode;
  nodes: AgentNode[];
  permissions: PermissionRequest[];
  workers: WorkerTask[];
  workersAt: number;
  now: number;
  onOpenAgent: (nodeId: string) => void;
  onDecide: (p: PermissionRequest, allow: boolean, message?: string) => void;
  onOpenWorkerLog?: (task: WorkerTask) => void;
}

const GROUP_LABEL: Record<ToolKey, string> = {
  read: 'Read',
  edit: 'Edit',
  bash: 'Bash',
  search: 'Search',
  web: 'Web',
  agent: 'Agent',
  other: 'Other',
};

function firstLine(s: string): string {
  const line = s.split('\n')[0].trim();
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

function ToolsRow({ item }: { item: Extract<ChatItem, { type: 'tools' }> }) {
  const counts: Record<string, number> = {};
  for (const c of item.counts) counts[c.tool] = c.count;
  const groups = toolGroups(counts);
  const text = groups.map((g) => `${GROUP_LABEL[g.key]} ${g.count}`).join(' · ');
  const uses = item.events.filter((e) => e.kind === 'tool_use');
  return (
    <details className="chat-tools">
      <summary>
        <span className="chat-tools-icons" aria-hidden="true">
          {groups.map((g) => (
            <span key={g.key} className="chat-tools-icon">
              {toolIcon(g.key, 12)}
            </span>
          ))}
        </span>
        <span>{text || 'Tools'}</span>
      </summary>
      <div className="chat-tools-list">
        {item.events.map((e) => {
          if (e.kind === 'tool_use') {
            const body = (
              <span className="chat-tool-row">
                <b>{e.tool ?? 'Tool'}</b>
                <span>{e.summary}</span>
              </span>
            );
            return e.detail ? (
              <details key={e.id} className="chat-tool-item">
                <summary>{body}</summary>
                <pre>{e.detail}</pre>
              </details>
            ) : (
              <div key={e.id} className="chat-tool-item">
                {body}
              </div>
            );
          }
          return (
            <div key={e.id} className={`chat-tool-result${e.isError ? ' is-error' : ''}`}>
              <span>
                {e.tool ?? 'Result'} · {e.summary}
              </span>
            </div>
          );
        })}
        {uses.length === 0 && <p className="muted">No tool calls.</p>}
      </div>
    </details>
  );
}

function HandoffCard({
  child,
  task,
  permission,
  now,
  workersAt,
  onOpenAgent,
  onDecide,
}: {
  child: AgentNode;
  task?: WorkerTask;
  permission?: PermissionRequest;
  now: number;
  workersAt: number;
  onOpenAgent: (nodeId: string) => void;
  onDecide: (p: PermissionRequest, allow: boolean, message?: string) => void;
}) {
  const [showFull, setShowFull] = useState(false);
  const isWorker = child.kind === 'worker' && child.worker;
  const name = isWorker ? `${child.worker!.lane} · ${child.worker!.slug}` : child.agentType;
  const waiting = child.status === 'waiting' || permission != null;
  const elapsed = task
    ? fmtDuration(workerElapsedS(task, now, workersAt) * 1000)
    : fmtDuration(elapsedMs(child, now));
  const statusClass =
    child.status === 'done' ? 'is-done' : child.status === 'error' || child.status === 'stopped' ? 'is-error' : waiting ? 'is-waiting' : 'is-running';
  const running = child.status === 'running' || waiting;
  const activity = task?.lastTool ?? child.lastActivity;
  const recentTools = child.events
    .filter((e) => e.kind === 'tool_use')
    .slice(-3);
  const resultLines = (child.result ?? '').split('\n');
  const resultPreview = resultLines.slice(0, 4).join('\n');
  const truncated = resultLines.length > 4;

  return (
    <div className={`handoff ${statusClass}`}>
      <div className="handoff-main">
        <span className="handoff-mark" aria-hidden="true">
          {child.status === 'done' ? (
            <span className="handoff-check">✓</span>
          ) : child.status === 'error' || child.status === 'stopped' ? (
            <span className="handoff-x">✕</span>
          ) : (
            <Orb size={20} state={orbState(child, waiting)} color={orbColor(child, task)} />
          )}
        </span>
        <div className="handoff-body">
          <p className="handoff-top">
            <b>{name}</b>
            {(task?.model ?? child.model) && <span className="chip">{modelLabel(task?.model ?? child.model)}</span>}
            <span className="handoff-time">{elapsed}</span>
          </p>
          {child.description && <p className="handoff-desc">{child.description}</p>}
          {running && activity && <p className="node-activity is-live">{activity}</p>}
          {running && recentTools.length > 0 && (
            <ul className="handoff-tools">
              {recentTools.map((e) => (
                <li key={e.id}>
                  {e.tool ?? 'Tool'} · {e.summary}
                </li>
              ))}
            </ul>
          )}
          {!running && child.result && (
            <div className="handoff-result">
              <Markdown text={showFull ? child.result : resultPreview} />
              {truncated && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowFull((v) => !v)}>
                  {showFull ? 'Show less' : 'Show full result'}
                </button>
              )}
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenAgent(child.id)}>
            Open →
          </button>
        </div>
      </div>
      {permission && (
        <PermissionPanel request={permission} onDecide={(allow, message) => onDecide(permission, allow, message)} />
      )}
    </div>
  );
}

export function ChatView({ node, nodes, permissions, workers, workersAt, now, onOpenAgent, onDecide, onOpenWorkerLog }: Props) {
  const children = nodes.filter((n) => n.parentId === node.id);
  const items = buildChat(node, children);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const permByNode = new Map<string, PermissionRequest>();
  for (const p of permissions) {
    if (!permByNode.has(p.nodeId)) permByNode.set(p.nodeId, p);
  }
  const pendingForNode = permissions.filter((p) => p.nodeId === node.id);
  const task = matchWorkerTask(node, workers);
  const trimmed = node.events.length >= MAX_EVENTS;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showPill, setShowPill] = useState(false);
  const stickRef = useRef(true);
  const lastKey = items.length > 0 ? `${items.length}:${items[items.length - 1].id}` : 'empty';

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowPill(false);
    } else {
      setShowPill(true);
    }
  }, [lastKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = nearBottom;
    if (nearBottom) setShowPill(false);
  };

  const scrollDown = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowPill(false);
  };

  const thinking = node.status === 'running' || node.status === 'waiting';
  const waiting = node.status === 'waiting' || permByNode.has(node.id);
  const state = orbState(node, waiting);

  return (
    <div className="chat-wrap">
      <div className="chat" role="log" aria-live="polite" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-col">
          {trimmed && <p className="chat-trimmed">Earlier activity trimmed</p>}
          {node.prompt && node.kind !== 'main' && (
            <details className="chat-given">
              <summary>What it was given</summary>
              <pre>{node.prompt}</pre>
              {node.kind === 'worker' && task && onOpenWorkerLog && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenWorkerLog(task)}>
                  Open worker log
                </button>
              )}
            </details>
          )}
          {items.map((item) => {
            if (item.type === 'user') {
              return (
                <p key={item.id} className="chat-user">
                  {item.text}
                </p>
              );
            }
            if (item.type === 'assistant') {
              return <Markdown key={item.id} className="chat-assistant" text={item.text} />;
            }
            if (item.type === 'thinking') {
              return (
                <details key={item.id} className="chat-thinking-row">
                  <summary>
                    <i>Thinking · {firstLine(item.summary)}</i>
                  </summary>
                  <p>{item.text}</p>
                </details>
              );
            }
            if (item.type === 'tools') {
              return <ToolsRow key={item.id} item={item} />;
            }
            if (item.type === 'handoff') {
              const child = byId.get(item.childId);
              if (!child) return null;
              return (
                <HandoffCard
                  key={item.id}
                  child={child}
                  task={matchWorkerTask(child, workers)}
                  permission={permByNode.get(child.id)}
                  now={now}
                  workersAt={workersAt}
                  onOpenAgent={onOpenAgent}
                  onDecide={onDecide}
                />
              );
            }
            if (item.type === 'permission') {
              return (
                <p key={item.id} className="chat-perm-line">
                  {item.event.tool ?? 'Permission'} · {item.event.summary}
                </p>
              );
            }
            return (
              <p key={item.id} className={`chat-note${item.isError ? ' is-error' : ''}`}>
                {item.text}
              </p>
            );
          })}
          {pendingForNode.map((p) => (
            <PermissionPanel key={p.id} request={p} onDecide={(allow, message) => onDecide(p, allow, message)} />
          ))}
          {thinking && (
            <div className="chat-thinking">
              <Orb size={32} state={state} color={orbColor(node)} />
              <span className="chat-thinking-label">{orbLabel(state)}</span>
              {node.lastActivity && <span className="chat-thinking-activity">{node.lastActivity}</span>}
            </div>
          )}
        </div>
      </div>
      {showPill && (
        <button type="button" className="chat-newpill" onClick={scrollDown}>
          ↓ New activity
        </button>
      )}
    </div>
  );
}
