// The swarm map: the root agent on top, then Running / Needs attention / Done sections.
// Done agents collapse into one-line rows so live work and failures stay in focus.
import { useEffect, useId, useMemo, useState } from 'react';
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';
import { NodeCard, NodeRow } from './NodeCard';
import { groupMapNodes, matchWorkerTask } from './chat';
import { ChevronIcon } from './icons';

interface Props {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
  workers: WorkerTask[];
  workersAt: number;
  now: number;
  openNodeId: string | null;
  onOpen: (nodeId: string) => void;
  onDecide: (permission: PermissionRequest, allow: boolean, message?: string, answers?: Record<string, string>) => void;
}

function SectionHead({ title, count }: { title: string; count: number }) {
  return (
    <h3 className="map-head">
      <span className="map-head-title">{title}</span>
      <span className="map-head-count">{count}</span>
    </h3>
  );
}

export function Tree({ nodes, permissions, workers, workersAt, now, openNodeId, onOpen, onDecide }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const doneId = useId();

  // Live WorkerTask per worker node: same sessionId+nodeId, else same lane+slug.
  const taskByNode = useMemo(() => {
    const m = new Map<string, WorkerTask>();
    for (const n of nodes) {
      if (n.kind !== 'worker') continue;
      const t = matchWorkerTask(n, workers);
      if (t) m.set(n.id, t);
    }
    return m;
  }, [nodes, workers]);

  const permByNode = useMemo(() => {
    const m = new Map<string, PermissionRequest>();
    for (const p of permissions) if (!m.has(p.nodeId)) m.set(p.nodeId, p);
    return m;
  }, [permissions]);

  const groups = useMemo(
    () => groupMapNodes(nodes, (n) => taskByNode.get(n.id), new Set(permByNode.keys())),
    [nodes, taskByNode, permByNode],
  );
  const { root, running, attention, done } = groups;

  // Keep the open agent's row visible: expand Done when the drawer is on one of its rows.
  const openInDone = openNodeId != null && done.some((n) => n.id === openNodeId);
  useEffect(() => {
    if (openInDone) setDoneOpen(true);
  }, [openInDone, openNodeId]);

  const card = (node: AgentNode) => (
    <li key={node.id}>
      <NodeCard
        node={node}
        now={now}
        task={taskByNode.get(node.id)}
        workersAt={workersAt}
        permission={permByNode.get(node.id)}
        open={openNodeId === node.id}
        onOpen={() => onOpen(node.id)}
        onDecide={onDecide}
      />
    </li>
  );

  const empty = nodes.length === 0;
  const lonely = root != null && running.length + attention.length + done.length === 0;

  return (
    <div className="swarm-map" role="region" aria-label="Agent map">
      <div className="swarm-inner">
        {empty && <p className="map-empty">No agents yet. They appear here as soon as the session starts one.</p>}

        {root && (
          <NodeCard
            root
            node={root}
            now={now}
            task={taskByNode.get(root.id)}
            workersAt={workersAt}
            permission={permByNode.get(root.id)}
            open={openNodeId === root.id}
            onOpen={() => onOpen(root.id)}
            onDecide={onDecide}
          />
        )}

        {lonely && <p className="map-empty">No subagents or workers yet. They show up here when the lead delegates.</p>}

        {running.length > 0 && (
          <section className="map-section" aria-label="Running">
            <SectionHead title="Running" count={running.length} />
            <ul className="map-grid">{running.map(card)}</ul>
          </section>
        )}

        {attention.length > 0 && (
          <section className="map-section" aria-label="Needs attention">
            <SectionHead title="Needs attention" count={attention.length} />
            <ul className="map-grid">{attention.map(card)}</ul>
          </section>
        )}

        {done.length > 0 && (
          <section className="map-section" aria-label="Done">
            <h3 className="map-head">
              <button
                type="button"
                className="map-toggle"
                aria-expanded={doneOpen}
                aria-controls={doneId}
                onClick={() => setDoneOpen((o) => !o)}
              >
                <ChevronIcon size={14} className="map-toggle-chevron" />
                <span className="map-head-title">Done</span>
                <span className="map-head-count">{done.length}</span>
                <span className="map-toggle-hint">{doneOpen ? 'Hide' : 'Show'}</span>
              </button>
            </h3>
            <ul className="map-rows" id={doneId} hidden={!doneOpen}>
              {done.map((node) => (
                <li key={node.id}>
                  <NodeRow
                    node={node}
                    now={now}
                    task={taskByNode.get(node.id)}
                    workersAt={workersAt}
                    open={openNodeId === node.id}
                    onOpen={() => onOpen(node.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
