// Shared start-session form state and agent/model selects (used by Landing and NewSession).
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentInfo, StartSessionBody } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { resolveDefaultCwd } from './FolderPicker';

export function useStartForm(
  backend: FleetBackend,
  guard: Guard,
  onStarted: (sessionId: string) => void,
) {
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
      if (res) onStarted(res.sessionId);
      else setStarting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session.');
      setStarting(false);
    }
  };

  return {
    cwd,
    setCwd,
    prompt,
    setPrompt,
    agent,
    setAgent,
    model,
    setModel,
    agents,
    starting,
    error,
    submit,
  };
}

interface FieldsProps {
  agents: AgentInfo[];
  agent: string;
  model: string;
  onAgent: (v: string) => void;
  onModel: (v: string) => void;
  agentId: string;
  modelId: string;
  layout: 'row' | 'stack';
}

export function AgentModelFields({
  agents,
  agent,
  model,
  onAgent,
  onModel,
  agentId,
  modelId,
  layout,
}: FieldsProps) {
  const agentField = (
    <>
      <label htmlFor={agentId}>Agent</label>
      <select id={agentId} value={agent} onChange={(e) => onAgent(e.target.value)}>
        <option value="">Default (no agent)</option>
        {agents.map((a) => (
          <option key={a.name} value={a.name}>
            {a.name}
            {a.description ? ` — ${a.description}` : ''}
          </option>
        ))}
      </select>
    </>
  );
  const modelField = (
    <>
      <label htmlFor={modelId}>Model</label>
      <select id={modelId} value={model} onChange={(e) => onModel(e.target.value)}>
        <option value="">Default</option>
        <option value="opus">Opus</option>
        <option value="sonnet">Sonnet</option>
        <option value="haiku">Haiku</option>
      </select>
    </>
  );
  if (layout === 'row') {
    return (
      <div className="land-row">
        <div className="land-field">{agentField}</div>
        <div className="land-field">{modelField}</div>
      </div>
    );
  }
  return (
    <>
      {agentField}
      {modelField}
    </>
  );
}
