// Landing: hero, what's running, start form, usage slot and recent sessions.
// Shown whenever no session is selected; on phones it is the first screen.
import { useEffect, useState } from 'react';
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { fmtCost, fmtDuration, shortModel, UNTRUSTED_NOTICE } from './format';
import { FolderPicker } from './FolderPicker';
import { Logo } from './icons';
import { AgentModelFields, useStartForm } from './StartForm';
import { SessionRow } from './SessionRow';
import { UsagePanel } from './Usage';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  sessions: SessionSummary[];
  workers: WorkerTask[];
  now: number;
  connected: boolean;
  /** Owned by App so the sidebar pill shares the same report. */
  usage: UsageReport | null;
  usageLoading: boolean;
  onRefreshUsage: () => void;
  onSelect: (id: string) => void;
  onOpenWorker: (task: WorkerTask) => void;
  onOpenWorkers: () => void;
  onOpenArchive: () => void;
  onStarted: (id: string) => void;
}

function splitPath(path: string): { name: string; parent: string } {
  const parts = path.split('/').filter(Boolean);
  return { name: parts.pop() ?? path, parent: parts.join('/') };
}

export function Landing({
  backend,
  guard,
  sessions,
  workers,
  now,
  connected,
  usage,
  usageLoading,
  onRefreshUsage,
  onSelect,
  onOpenWorker,
  onOpenWorkers,
  onOpenArchive,
  onStarted,
}: Props) {
  const {
    cwd,
    setCwd,
    prompt,
    setPrompt,
    agent,
    setAgent,
    model,
    setModel,
    effort,
    setEffort,
    agents,
    starting,
    error,
    submit,
  } = useStartForm(backend, guard, onStarted);

  // Recent working dirs for one-tap repo chips (most recent first).
  const [cwds, setCwds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    guard(backend.cwds())
      .then((list) => {
        if (alive && list) setCwds(list.slice(0, 8));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, guard]);

  const running = sessions.filter((s) => s.status === 'running' || s.status === 'waiting');
  const runningWorkers = workers.filter((w) => w.state === 'running');
  // Ended sessions that can actually be continued; the rest stay hidden everywhere.
  const ended = sessions
    .filter((s) => s.resumable === true)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const recent = ended.slice(0, 5);

  return (
    <div className="landing">
      <div className="landing-inner">
        <header className="land-hero">
          <Logo size={48} />
          <p className="land-kicker">SwarmKit dashboard</p>
          <h1>One mind plans, a swarm builds.</h1>
          <p className="land-lede">
            Give the lead agent a goal and it fans the work out to a swarm — watch every branch live,
            decide permissions, and pull the results back in.
          </p>
          <span className={`conn-chip ${connected ? 'is-live' : 'is-offline'}`}>
            <i className={`dot ${connected ? 'st-running' : 'st-error'}`} aria-hidden="true" />
            {connected ? 'Live' : 'Offline'}
          </span>
        </header>

        <div className="land-grid">
          <div className="land-col">
            <section className="land-running" aria-label="Running now">
              <h2 className="land-heading">Running now</h2>
              {running.length === 0 && runningWorkers.length === 0 ? (
                <p className="muted land-none">Nothing running. Start something below.</p>
              ) : (
                <>
                  {running.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="land-run"
                      onClick={() => onSelect(s.id)}
                      title={s.cwd}
                    >
                      <span className="land-run-top">
                        <span className="land-run-name">{s.title || s.project}</span>
                        {s.pendingPermissions > 0 && (
                          <span className="pending-chip" title="Waiting on your decision">
                            {s.pendingPermissions} pending
                          </span>
                        )}
                        <span className={`node-status st-${s.status}`}>
                          <i className={`dot st-${s.status}`} aria-hidden="true" />
                          {s.status}
                        </span>
                      </span>
                      <span className="land-run-cwd">{s.cwd}</span>
                      <span className="land-run-foot">
                        <span>elapsed {fmtDuration(now - s.startedAt)}</span>
                        <i className="sep" aria-hidden="true">·</i>
                        <span>{fmtCost(s.costUsd)}</span>
                      </span>
                    </button>
                  ))}
                  {runningWorkers.map((w) => (
                    <button
                      key={`${w.lane}/${w.repo}/${w.slug}`}
                      type="button"
                      className="land-wk-row"
                      onClick={() => onOpenWorker(w)}
                      aria-haspopup="dialog"
                    >
                      <span className={`badge lane-${w.lane}`}>{w.lane}</span>
                      <span className="land-wk-slug">{w.slug}</span>
                      {w.model && <span className="land-wk-model">{shortModel(w.model)}</span>}
                    </button>
                  ))}
                  {workers.length > 0 && (
                    <button type="button" className="land-all-link" onClick={onOpenWorkers}>
                      All workers
                    </button>
                  )}
                </>
              )}
            </section>

            <form className="land-card" onSubmit={submit}>
              <h2>Start a session</h2>
              <p className="muted land-sub">Pick a repo, describe the task, and the swarm fans out.</p>

              {cwds.length > 0 && (
                <div className="land-repos-wrap" aria-label="Recent repos">
                  <div className="land-repos">
                    {cwds.map((path) => {
                    const { name, parent } = splitPath(path);
                    return (
                      <button
                        key={path}
                        type="button"
                        className="repo-chip"
                        title={path}
                        aria-pressed={cwd.trim() === path || undefined}
                        onClick={() => setCwd(path)}
                      >
                        <b>{name}</b>
                        <span className="repo-chip-path">{parent}</span>
                      </button>
                    );
                    })}
                  </div>
                </div>
              )}

              <details className="land-other">
                <summary>Other folder…</summary>
                <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} />
              </details>

              {sessions.some((s) => s.cwd === cwd.trim() && s.untrustedProject) && (
                <p className="notice" role="note">
                  {UNTRUSTED_NOTICE}
                </p>
              )}

              <label htmlFor="land-prompt">Prompt</label>
              <textarea
                id="land-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="What should the swarm do?"
              />

              <AgentModelFields
                agents={agents}
                agent={agent}
                model={model}
                effort={effort}
                onAgent={setAgent}
                onModel={setModel}
                onEffort={setEffort}
                agentId="land-agent"
                modelId="land-model"
                effortId="land-effort"
                layout="row"
              />

              {error && (
                <p className="dialog-error" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="btn btn-primary land-start"
                disabled={!prompt.trim() || !cwd.trim() || starting}
              >
                {starting ? 'Starting…' : 'Start session'}
              </button>
            </form>
          </div>

          <div className="land-col">
            <section className="land-usage land-card" data-slot="usage" aria-label="Usage limits">
              <h2>Usage</h2>
              <UsagePanel report={usage} loading={usageLoading} onRefresh={onRefreshUsage} />
            </section>

            <section className="land-recent" aria-label="Recently ended">
              <h3>Recently ended</h3>
              {ended.length === 0 ? (
                <p className="muted land-none">No ended sessions yet — sessions you can continue will appear here.</p>
              ) : (
                <>
                  {recent.map((s) => (
                    <SessionRow key={s.id} session={s} now={now} onSelect={onSelect} />
                  ))}
                  <button type="button" className="land-show-more" onClick={onOpenArchive}>
                    Open archive ({ended.length})
                  </button>
                </>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
