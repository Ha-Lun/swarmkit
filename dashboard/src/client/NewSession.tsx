// New session dialog: prompt, folder picker (shared with the landing page), agent, model.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentInfo, StartSessionBody, StartSessionResponse } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderPicker, resolveDefaultCwd } from './FolderPicker';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}

export function NewSession({ backend, guard, onClose, onStarted }: Props) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    void resolveDefaultCwd(backend).then((c) => {
      if (alive && c) setCwd(c);
    });
    return () => {
      alive = false;
    };
  }, [backend]);

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
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="ns-title" onSubmit={submit}>
        <h2 id="ns-title">New session</h2>

        <label htmlFor="ns-prompt">Prompt</label>
        <textarea
          id="ns-prompt"
          autoFocus
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What should the fleet do?"
        />

        <p className="dialog-label" id="ns-cwd-label">Working directory</p>
        <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} labelledby="ns-cwd-label" />

        <label htmlFor="ns-agent">Agent</label>
        <select id="ns-agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Default (no agent)</option>
          {agents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.description ? ` — ${a.description}` : ''}
            </option>
          ))}
        </select>

        <label htmlFor="ns-model">Model</label>
        <select id="ns-model" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Default</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>

        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!prompt.trim() || !cwd.trim() || starting}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
