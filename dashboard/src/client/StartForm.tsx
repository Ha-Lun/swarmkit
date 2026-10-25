// Shared start-session form state and model selects (used by Landing and NewSession).
// Every setup runs the lead-dev-hybrid agent; only the runtime/model/effort vary.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { RUNTIME_MODELS } from '../shared/types';
import type { Runtime, RuntimesResponse, StartSessionBody } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { useAttachments } from './attachments';
import type { UseAttachments } from './attachments';
import { resolveDefaultCwd } from './FolderPicker';

export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const SETUP_ORDER: Runtime[] = ['claude', 'opencode', 'agy'];
const SETUP_LABEL: Record<Runtime, string> = {
  claude: 'Claude + workers',
  opencode: 'OpenCode + agy',
  agy: 'agy only',
};
const SETUP_SHORT: Record<Runtime, string> = { claude: 'Claude', opencode: 'OpenCode', agy: 'agy' };
const SETUP_DESC: Record<Runtime, string> = {
  claude: 'Claude lead · opencode + agy workers',
  opencode: 'OpenCode lead · agy worker',
  agy: 'Antigravity lead, no workers',
};
const SETUP_MODEL: Record<Runtime, string> = {
  claude: 'opus',
  opencode: RUNTIME_MODELS.opencode[0] ?? 'opencode-go/mimo-v2.6-pro',
  agy: RUNTIME_MODELS.agy[0] ?? 'gemini-3.8-flash-high',
};

/** The only agent any setup starts with. */
export const LEAD_AGENT = 'lead-dev-hybrid';

function readSetup(): Runtime {
  try {
    const v = localStorage.getItem('fleet.setup');
    if (v === 'claude' || v === 'opencode' || v === 'agy') return v;
  } catch {
    // private mode — default per pageload
  }
  return 'claude';
}

export function useStartForm(
  backend: FleetBackend,
  guard: Guard,
  onStarted: (sessionId: string) => void,
) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntimeInner] = useState<Runtime>(readSetup);
  const [model, setModel] = useState<string>(() => SETUP_MODEL[readSetup()]);
  const [effort, setEffort] = useState<EffortValue>('high');
  const [availability, setAvailability] = useState<RuntimesResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments: UseAttachments = useAttachments();

  const setRuntime = (r: Runtime) => {
    setRuntimeInner(r);
    setModel(SETUP_MODEL[r]);
    try {
      localStorage.setItem('fleet.setup', r);
    } catch {
      // private mode — remembered per pageload then
    }
  };

  // Lead-runtime availability on the server's PATH (all enabled until known).
  useEffect(() => {
    let alive = true;
    guard(backend.runtimes())
      .then((r) => {
        if (alive && r) setAvailability(r);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, guard]);

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

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = prompt.trim();
    const c = cwd.trim();
    const images = attachments.toPayload();
    if ((!p && images.length === 0) || !c || starting) return;
    setStarting(true);
    setError(null);
    try {
      const body: StartSessionBody = {
        prompt: p,
        cwd: c,
        agent: LEAD_AGENT,
        ...(model ? { model } : {}),
        ...(runtime === 'opencode' ? {} : { effort }),
        runtime,
        ...(images.length > 0 ? { images } : {}),
      };
      const res = await guard(backend.start(body));
      if (res) {
        attachments.clear();
        onStarted(res.sessionId);
      } else setStarting(false);
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
    runtime,
    setRuntime,
    availability,
    model,
    setModel,
    effort,
    setEffort,
    attachments,
    starting,
    error,
    submit,
  };
}

interface FieldsProps {
  runtime: Runtime;
  availability: RuntimesResponse | null;
  model: string;
  effort: EffortValue;
  onRuntime: (v: Runtime) => void;
  onModel: (v: string) => void;
  onEffort: (v: EffortValue) => void;
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
  runtime,
  availability,
  model,
  effort,
  onRuntime,
  onModel,
  onEffort,
  modelId,
  effortId,
  layout,
}: FieldsProps) {
  const [open, setOpen] = useState(false);
  const panelId = `${modelId}-panel`;
  const modelShown = model || SETUP_MODEL[runtime];
  const summary =
    runtime === 'claude'
      ? `${LEAD_AGENT} · ${modelLabel(modelShown)} · ${effort ? `${effort} effort` : 'default effort'}`
      : `${SETUP_LABEL[runtime]} · ${modelShown}${runtime === 'agy' && effort ? ` · ${effort} effort` : ''}`;
  const setupField = (
    <div className="amf-setup">
      <div className="view-toggle setup-seg" role="group" aria-label="Setup">
        {SETUP_ORDER.map((r) => {
          const ok = !availability || availability[r] !== false;
          return (
            <button
              key={r}
              type="button"
              aria-pressed={runtime === r}
              className={runtime === r ? 'is-active' : undefined}
              disabled={!ok}
              aria-label={SETUP_LABEL[r]}
              title={ok ? SETUP_LABEL[r] : `${r} not found on PATH`}
              onClick={() => onRuntime(r)}
            >
              {SETUP_SHORT[r]}
            </button>
          );
        })}
      </div>
      <p className="muted setup-desc">{SETUP_DESC[runtime]}</p>
    </div>
  );
  const agentField = (
    <>
      <label htmlFor={`${modelId}-agent`}>Agent</label>
      <span className="badge" id={`${modelId}-agent`}>
        {LEAD_AGENT}
      </span>
    </>
  );
  const modelField =
    runtime === 'claude' ? (
      <>
        <label htmlFor={modelId}>Model</label>
        <select id={modelId} value={model} onChange={(e) => onModel(e.target.value)}>
          <option value="">Default</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
          <option value="haiku">Haiku</option>
        </select>
      </>
    ) : (
      <>
        <label htmlFor={modelId}>Model</label>
        <select id={modelId} value={modelShown} onChange={(e) => onModel(e.target.value)}>
          {RUNTIME_MODELS[runtime].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
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
      {setupField}
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
          <div id={panelId}>
            <div className="land-row">
              <div className="land-field">{agentField}</div>
              <div className="land-field">{modelField}</div>
              {runtime !== 'opencode' && <div className="land-field">{effortField}</div>}
            </div>
          </div>
        ) : (
          <div id={panelId} className="amf-stack">
            {agentField}
            {modelField}
            {runtime !== 'opencode' && effortField}
          </div>
        ))}
    </div>
  );
}
