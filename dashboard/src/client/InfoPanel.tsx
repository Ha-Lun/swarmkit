// InfoPanel: the right column of an open session. Environment (runtime, agent, model, cwd, git),
// Context (tokens and cost of the lead) and Agents & workers (click to open). `detail` is
// undefined while the session loads; the panel then shows the summary fields only.
import { useEffect } from 'react';
import type { GitInfo, SessionDetail, SessionSummary, WorkerTask } from '../shared/types';
import { GitStatus } from './Composer';
import { agentLabel, agentSubtitle, matchWorkerTask } from './chat';
import { fmtCost, fmtTokens, modelLabel, workerStateClass } from './format';

const RUNTIME_NAMES = { claude: 'Claude Code', opencode: 'OpenCode', agy: 'Antigravity' } as const;

interface Props {
  session: SessionSummary;
  detail?: SessionDetail;
  git?: GitInfo;
  workers: WorkerTask[];
  activeAgentId: string;
  /** Narrow screens: the panel overlays the chat, so it can be dismissed with Escape. */
  overlay: boolean;
  onOpenAgent: (nodeId: string) => void;
  onOpenWorker: (task: WorkerTask) => void;
  onClose: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function InfoPanel({
  session,
  detail,
  git,
  workers,
  activeAgentId,
  overlay,
  onOpenAgent,
  onOpenWorker,
  onClose,
}: Props) {
  const runtime = session.runtime ?? 'claude';
  const root = detail?.nodes.find((n) => n.kind === 'main') ?? detail?.nodes.find((n) => n.id === 'root');
  const members = detail?.nodes.filter((n) => n.kind !== 'main' && n.id !== root?.id) ?? [];

  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlay, onClose]);

  const tokens = root?.tokens;
  const cost = root ? Math.max(root.costUsd, session.costUsd) : session.costUsd;

  return (
    <aside className={`info-panel${overlay ? ' is-overlay' : ''}`} aria-label="Session info">
      <div className="info-head">
        <span>Session info</span>
        <button type="button" className="info-close" aria-label="Close session info" onClick={onClose}>
          ×
        </button>
      </div>

      <section className="info-section" aria-labelledby="info-env">
        <h2 id="info-env" className="info-h">Environment</h2>
        <dl className="info-list">
          <Row label="runtime">
            <span className="info-runtime">
              <i className="rt-dot" data-runtime={runtime} aria-hidden="true" />
              {RUNTIME_NAMES[runtime]}
            </span>
          </Row>
          {session.agent && <Row label="agent">{session.agent}</Row>}
          {session.model && <Row label="model">{modelLabel(session.model)}</Row>}
          <Row label="cwd">
            <span className="info-path" title={session.cwd}>{session.cwd}</span>
          </Row>
          {git && (
            <Row label="branch">
              <GitStatus git={git} />
            </Row>
          )}
          {git?.worktreeOf && (
            <Row label="worktree">
              <span className="info-path" title={git.worktreeOf}>{git.worktreeOf}</span>
            </Row>
          )}
          <Row label="session">{session.id.slice(0, 8)}</Row>
        </dl>
      </section>

      <section className="info-section" aria-labelledby="info-ctx">
        <h2 id="info-ctx" className="info-h">Context</h2>
        {tokens ? (
          <dl className="info-list">
            <Row label="tokens in">{fmtTokens(tokens.input)}</Row>
            <Row label="tokens out">{fmtTokens(tokens.output)}</Row>
            <Row label="cache">
              {fmtTokens(tokens.cacheRead)} read · {fmtTokens(tokens.cacheWrite)} write
            </Row>
            <Row label="cost">{fmtCost(cost)}</Row>
          </dl>
        ) : (
          <dl className="info-list">
            <Row label="cost">{fmtCost(cost)}</Row>
          </dl>
        )}
      </section>

      <section className="info-section" aria-labelledby="info-agents">
        <h2 id="info-agents" className="info-h">
          Agents &amp; workers{members.length > 0 ? ` (${members.length})` : ''}
        </h2>
        {!detail ? (
          <p className="info-empty">Loading…</p>
        ) : members.length === 0 ? (
          <p className="info-empty">No subagents or workers yet.</p>
        ) : (
          <ul className="info-members">
            {members.map((n) => {
              const task = matchWorkerTask(n, workers);
              const sub = agentSubtitle(n, task);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`info-member${n.id === activeAgentId ? ' is-active' : ''}`}
                    aria-current={n.id === activeAgentId ? 'true' : undefined}
                    title={[agentLabel(n), sub].filter(Boolean).join(' — ')}
                    onClick={() => (task ? onOpenWorker(task) : onOpenAgent(n.id))}
                  >
                    <i
                      className={`dot ${task ? workerStateClass(task.state) : `st-${n.status}`}`}
                      aria-hidden="true"
                    />
                    <span className="info-member-text">
                      <span className="info-member-name">{agentLabel(n)}</span>
                      {sub && <span className="info-member-sub">{sub}</span>}
                    </span>
                    <span className="sr-only">, {task ? task.state : n.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
