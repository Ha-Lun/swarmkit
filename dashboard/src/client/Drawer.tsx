// Right-side detail drawer: agent metadata, prompt, activity timeline, result.
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ActivityEvent, AgentNode } from '../shared/types';
import { fmtClock, fmtCost, fmtTokens, modelLabel } from './format';
import { ChevronIcon, CloseIcon } from './icons';

interface Props {
  node: AgentNode;
  onClose: () => void;
}

function tagFor(ev: ActivityEvent): string {
  switch (ev.kind) {
    case 'user':
      return 'You';
    case 'text':
      return 'Agent';
    case 'tool_use':
      return ev.tool ?? 'Tool';
    case 'tool_result':
      return ev.tool ? `${ev.tool} · result` : 'Result';
    case 'permission':
      return 'Permission';
    case 'system':
      return 'System';
    case 'result':
      return 'Result';
    default:
      return ev.kind;
  }
}

/** Controlled-free collapsible: stateful so live updates don't reset user-toggled open state. */
function Collapse({
  defaultOpen = false,
  children,
  summary,
}: {
  defaultOpen?: boolean;
  children?: ReactNode;
  summary: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="collapsible" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function TimelineItem({ ev }: { ev: ActivityEvent }) {
  const cls = `tl tl-${ev.kind}${ev.isError ? ' tl-error' : ''}`;
  const head = (
    <>
      <span className="tl-tag">{tagFor(ev)}</span>
      <span className="tl-sum" title={ev.summary}>
        {ev.summary}
      </span>
      <span className="tl-time">{fmtClock(ev.ts)}</span>
      {ev.detail && <ChevronIcon size={12} />}
    </>
  );

  if (ev.kind === 'thinking') {
    return (
      <li className={cls}>
        <Collapse
          summary={
            <>
              <span className="tl-tag">Thinking</span>
              <span className="tl-sum">{ev.summary}</span>
              <span className="tl-time">{fmtClock(ev.ts)}</span>
              <ChevronIcon size={12} />
            </>
          }
        >
          <p className="tl-body thinking-body">{ev.detail ?? ev.summary}</p>
        </Collapse>
      </li>
    );
  }

  if (!ev.detail) {
    return (
      <li className={cls}>
        <div className="tl-head">{head}</div>
      </li>
    );
  }

  return (
    <li className={cls}>
      <Collapse defaultOpen={ev.kind === 'user' || ev.kind === 'text' || ev.kind === 'result'} summary={head}>
        <pre className="tl-detail-pre">{ev.detail}</pre>
      </Collapse>
    </li>
  );
}

export function Drawer({ node, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const worker = node.kind === 'worker' ? node.worker : undefined;

  return (
    <aside className="drawer" role="dialog" aria-label={`${node.agentType} details`}>
      <header className="drawer-head">
        <div style={{ minWidth: 0 }}>
          <p className="drawer-title">
            {worker ? `${worker.lane} · ${worker.slug}` : node.agentType}
          </p>
          <p className="drawer-sub">
            <span className={`node-status st-${node.status}`}>
              <i className="dot" aria-hidden="true" />
              {node.status}
            </span>
            {node.model && <span className="chip">{modelLabel(node.model)}</span>}
            {node.kind === 'worker' && <span className="chip">worker</span>}
            <span>{fmtCost(node.costUsd)}</span>
          </p>
        </div>
        <button ref={closeRef} type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>

      <div className="drawer-body">
        <div className="drawer-stats">
          <div>
            <span>Cost</span>
            <b>{fmtCost(node.costUsd)}</b>
          </div>
          <div>
            <span>Input</span>
            <b>{fmtTokens(node.tokens.input)}</b>
          </div>
          <div>
            <span>Output</span>
            <b>{fmtTokens(node.tokens.output)}</b>
          </div>
          <div>
            <span>Cache</span>
            <b>{fmtTokens(node.tokens.cacheRead + node.tokens.cacheWrite)}</b>
          </div>
        </div>

        {node.prompt && (
          <section aria-label="Prompt">
            <h3>Prompt</h3>
            <details className="collapsible drawer-prompt">
              <summary>
                What this agent was given
                <ChevronIcon size={12} />
              </summary>
              <pre>{node.prompt}</pre>
            </details>
          </section>
        )}

        <section className="timeline" aria-label="Activity timeline">
          <h3>Activity</h3>
          {node.events.length === 0 ? (
            <p className="timeline-empty">No activity yet.</p>
          ) : (
            <ol>
              {node.events.map((ev) => (
                <TimelineItem key={ev.id} ev={ev} />
              ))}
            </ol>
          )}
        </section>

        {node.result && (
          <section aria-label="Result">
            <h3>Result</h3>
            <p>{node.result}</p>
          </section>
        )}
      </div>
    </aside>
  );
}
