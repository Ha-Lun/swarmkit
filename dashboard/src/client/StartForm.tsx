// Shared start-session form state and agent/model selects (used by Landing and NewSession).
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AgentInfo, StartSessionBody } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { resolveDefaultCwd } from './FolderPicker';

export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function useStartForm(
  backend: FleetBackend,
  guard: Guard,
  onStarted: (sessionId: string) => void,
) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [agent, setAgentInner] = useState('');
  const [model, setModel] = useState('opus');
  const [effort, setEffort] = useState<EffortValue>('high');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentTouched = useRef(false);

  const setAgent = (v: string) => {
    agentTouched.current = true;
    setAgentInner(v);
  };

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

  // Default agent once the list for the cwd is known; never override an explicit pick.
  useEffect(() => {
    if (agentTouched.current) return;
    if (agents.some((a) => a.name === 'lead-dev-hybrid')) {
      setAgentInner('lead-dev-hybrid');
    } else {
      setAgentInner('');
    }
  }, [agents]);

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
        effort,
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
    effort,
    setEffort,
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
  effort: EffortValue;
  onAgent: (v: string) => void;
  onModel: (v: string) => void;
  onEffort: (v: EffortValue) => void;
  agentId: string;
  modelId: string;
  effortId: string;
  layout: 'row' | 'stack';
}

function modelLabel(model: string): string {
  if (model === 'opus') return 'Opus';
  if (model === 'sonnet') return 'Sonnet';
  if (model === 'haiku') return 'Haiku';
  if (!model) return 'Default';
  return model;
}

export function AgentModelFields({
  agents,
  agent,
  model,
  effort,
  onAgent,
  onModel,
  onEffort,
  agentId,
  modelId,
  effortId,
  layout,
}: FieldsProps) {
  const [open, setOpen] = useState(false);
  const panelId = `${agentId}-panel`;
  const agentLabel = agent || 'Default';
  const summary = `${agentLabel} · ${modelLabel(model)} · ${effort ? `${effort} effort` : 'default effort'}`;
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
  const effortField = (
    <>
      <label htmlFor={effortId}>Effort</label>
      <select
        id={effortId}
        value={effort}
        onChange={(e) => onEffort(e.target.value as EffortValue)}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
        <option value="xhigh">Extra high</option>
        <option value="max">Max</option>
      </select>
    </>
  );
  return (
    <div className="amf">
      <div className="amf-summary">
        <span className="amf-summary-text">{summary}</span>
        <button
          type="button"
          className="amf-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Change'}
        </button>
      </div>
      {open &&
        (layout === 'row' ? (
          <div id={panelId} className="land-row">
            <div className="land-field">{agentField}</div>
            <div className="land-field">{modelField}</div>
            <div className="land-field">{effortField}</div>
          </div>
        ) : (
          <div id={panelId} className="amf-stack">
            {agentField}
            {modelField}
            {effortField}
          </div>
        ))}
    </div>
  );
}
