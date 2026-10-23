// One agent card. Pure display + permission panel slot; positioning handled by Tree.
import type { KeyboardEvent } from 'react';
import type { AgentNode, PermissionRequest } from '../shared/types';
import { elapsedMs, fmtCost, fmtDuration, modelLabel, toolGroups } from './format';
import { kindIcon, toolIcon } from './icons';
import { PermissionPanel } from './Permission';

interface Props {
  node: AgentNode;
  now: number;
  permission?: PermissionRequest;
  open: boolean;
  onOpen: () => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string) => void;
  clickGuard: () => boolean;
}

function isFormTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return ['BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'A', 'SUMMARY'].includes(el.tagName);
}

export function NodeCard({ node, now, permission, open, onOpen, onDecide, clickGuard }: Props) {
  const isWorker = node.kind === 'worker' && node.worker;
  const name = isWorker ? `${node.worker!.lane} · ${node.worker!.slug}` : node.agentType;
  const groups = toolGroups(node.toolCounts);

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
        {node.model && <span className="chip">{modelLabel(node.model)}</span>}
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

      {node.description && <p className="node-desc">{node.description}</p>}
      {node.lastActivity && <p className="node-activity" title={node.lastActivity}>{node.lastActivity}</p>}

      <div className="node-foot">
        <span className="node-cost">
          {fmtCost(node.costUsd)}
          <i className="sep">·</i>
          {fmtDuration(elapsedMs(node, now))}
        </span>
        <span className={`node-status st-${node.status}`}>
          <i className="dot" aria-hidden="true" />
          {node.status}
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
