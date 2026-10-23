// Landing: centred "Start working" card (folder picker + prompt + options) and recent sessions.
// Shown whenever no session is selected; on phones it is the first screen.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentInfo, SessionSummary, StartSessionBody, StartSessionResponse } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderPicker, resolveDefaultCwd } from './FolderPicker';
import { fmtCost, relTime } from './format';
import { TerminalIcon } from './icons';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  sessions: SessionSummary[];
  now: number;
  onSelect: (id: string) => void;
  onStarted: (id: string) => void;
}

export function Landing({ backend, guard, sessions, now, onSelect, onStarted }: Props) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default folder: last used (localStorage), else first recent, else home (empty = home).
  useEffect(() => {
    let alive = true;
    void resolveDefaultCwd(backend).then((c) => {
      if (alive && c) setCwd(c);
    });
    return () => {
      alive = false;
    };
  }, [backend]);

  // Agents available in the selected folder (debounced).
  useEffect(() => {
    if (!cwd.trim()) {
      setAgents([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      guard(backend.agents(cwd.trim()))
        .then((r) => {
          if (alive) setAgents(r?.agents ?? []);
        })
        .catch(() => {
          if (alive) setAgents([]);
        });
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [cwd, backend, guard]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = prompt.trim();
    const c = cwd.trim();
    if (!p || !c || starting) return;
    setStarting(true);
    setError(null);
    try {
      const body: StartSessionBody = {
        prompt: p,
        cwd: c,
        agent: agent || undefined,
        model: model || undefined,
      };
      const res = await guard(backend.start(body));
      if (res) onStarted((res as StartSessionResponse).sessionId);
      else setStarting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session.');
      setStarting(false);
    }
  };

  return (
    <div className="landing">
      <div className="landing-inner">
        <form className="land-card" onSubmit={submit}>
          <h2>Start working</h2>
          <p className="muted land-sub">Pick a project folder, describe the task, and the fleet fans out.</p>

          <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} />

          <label htmlFor="land-prompt">Prompt</label>
          <textarea
            id="land-prompt"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the fleet do?"
          />

          <div className="land-row">
            <div className="land-field">
              <label htmlFor="land-agent">Agent</label>
              <select id="land-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">Default (no agent)</option>
                {agents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                    {a.description ? ` — ${a.description}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="land-field">
              <label htmlFor="land-model">Model</label>
              <select id="land-model" value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Default</option>
                <option value="opus">Opus</option>
                <option value="sonnet">Sonnet</option>
                <option value="haiku">Haiku</option>
              </select>
            </div>
          </div>

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

        <section className="land-recent" aria-label="Recent sessions">
          <h3>Recent sessions</h3>
          {sessions.length === 0 ? (
            <p className="muted land-none">Nothing yet — start your first session above.</p>
          ) : (
            sessions.map((s) => (
              <button key={s.id} type="button" className="sess" onClick={() => onSelect(s.id)}>
                <span className="sess-top">
                  <span className={`badge src-${s.source}`}>
                    {s.source === 'terminal' && <TerminalIcon size={10} />}
                    {s.source}
                  </span>
                  <span className="sess-project">{s.project}</span>
                  <span className={`dot st-${s.status}`} aria-hidden="true" />
                </span>
                <span className="sess-title">{s.title || s.project}</span>
                <span className="sess-meta">
                  {relTime(s.updatedAt, now)} · {fmtCost(s.costUsd)}
                </span>
              </button>
            ))
          )}
        </section>
      </div>
    </div>
  );
}
