// Shared start-session form state and model selects (used by Landing and NewSession).
// Every setup runs the lead-dev-hybrid agent; only the runtime/model vary. The Claude setup has no
// model or effort choice: the server picks both per task with a Haiku triage.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { RUNTIME_MODELS } from '../shared/types';
import type { Runtime, RuntimesResponse, StartSessionBody } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { useAttachments } from './attachments';
import type { UseAttachments } from './attachments';
import { MetaLine, providerName } from './Composer';
import { modelLabel as shortModelLabel } from './format';
import { resolveDefaultCwd } from './FolderPicker';

export const SETUP_ORDER: Runtime[] = ['claude', 'opencode', 'agy'];
const SETUP_LABEL: Record<Runtime, string> = {
  claude: 'Claude + workers',
  opencode: 'OpenCode + Antigravity',
  agy: 'Antigravity only',
};
const SETUP_SHORT: Record<Runtime, string> = { claude: 'Claude', opencode: 'OpenCode', agy: 'Antigravity' };
const SETUP_DESC: Record<Runtime, string> = {
  claude: 'Claude lead, OpenCode + Antigravity workers',
  opencode: 'OpenCode lead, Antigravity worker',
  agy: 'Antigravity lead, no workers',
};
/** Model a setup starts with; Claude has none (the server's triage picks it). */
const SETUP_MODEL: Record<Runtime, string> = {
  claude: '',
  opencode: RUNTIME_MODELS.opencode[0] ?? 'opencode-go/mimo-v2.6-pro',
  agy: RUNTIME_MODELS.agy[0] ?? 'gemini-4-argon-high',
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

/** What a Claude start shows in the chat while the triage runs: the prompt as sent, and its attachments. */
export interface StartDraft {
  prompt: string;
  /** Thumbnail object URLs; the owner of the draft revokes them. */
  images: string[];
  files: string[];
}

export function useStartForm(
  backend: FleetBackend,
  guard: Guard,
  onStarted: (sessionId: string, handoff?: StartDraft) => void,
) {
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [runtime, setRuntimeInner] = useState<Runtime>(readSetup);
  const [model, setModel] = useState<string>(() => SETUP_MODEL[readSetup()]);
  const [availability, setAvailability] = useState<RuntimesResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set while a Claude start waits on the server's model triage: the form swaps to a chat with this prompt.
  const [pending, setPending] = useState<StartDraft | null>(null);
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
    const files = attachments.toFiles();
    if ((!p && images.length === 0 && files.length === 0) || !c || starting) return;
    const draft: StartDraft | null =
      runtime === 'claude'
        ? { prompt: p, images: attachments.items.map((i) => i.previewUrl), files: attachments.files.map((f) => f.name) }
        : null;
    setStarting(true);
    setError(null);
    setPending(draft);
    try {
      const body: StartSessionBody = {
        prompt: p,
        cwd: c,
        agent: LEAD_AGENT,
        // Claude: neither model nor effort, the server triages them.
        ...(runtime !== 'claude' && model ? { model } : {}),
        runtime,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
      const res = await guard(backend.start(body));
      if (res) {
        // The chat view keeps showing the thumbnails until the session loads, so it takes the URLs over.
        attachments.clear(draft !== null);
        onStarted(res.sessionId, draft ?? undefined);
      } else {
        setStarting(false);
        setPending(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session.');
      setStarting(false);
      setPending(null);
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
    attachments,
    starting,
    pending,
    error,
    submit,
  };
}

interface FieldsProps {
  runtime: Runtime;
  availability: RuntimesResponse | null;
  model: string;
  onRuntime: (v: Runtime) => void;
  onModel: (v: string) => void;
  modelId: string;
  layout: 'row' | 'stack';
}

export function AgentModelFields({
  runtime,
  availability,
  model,
  onRuntime,
  onModel,
  modelId,
  layout,
}: FieldsProps) {
  const [open, setOpen] = useState(false);
  const panelId = `${modelId}-panel`;
  const modelShown = model || SETUP_MODEL[runtime];
  const models = runtime === 'claude' ? [] : RUNTIME_MODELS[runtime];
  const summary =
    runtime === 'claude'
      ? `${LEAD_AGENT} · Auto`
      : `${SETUP_LABEL[runtime]} · ${shortModelLabel(modelShown) || 'Default'}`;
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
  const modelField = (
    <>
      <label htmlFor={modelId}>Model</label>
      <select id={modelId} value={modelShown} onChange={(e) => onModel(e.target.value)}>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </>
  );
  return (
    <div className="amf">
      {setupField}
      <div className="amf-summary">
        <span className="amf-summary-text">{summary}</span>
        {runtime === 'claude' ? (
          <span className="amf-note">Model picked per task (Haiku)</span>
        ) : (
          <button
            type="button"
            className="amf-toggle"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide' : 'Change'}
          </button>
        )}
      </div>
      {open &&
        runtime !== 'claude' &&
        (layout === 'row' ? (
          <div id={panelId}>
            <div className="land-row">
              <div className="land-field">{agentField}</div>
              <div className="land-field">{modelField}</div>
            </div>
          </div>
        ) : (
          <div id={panelId} className="amf-stack">
            {agentField}
            {modelField}
          </div>
        ))}
    </div>
  );
}

/** The next setup after `current` that is installed; `current` itself when it is the only one. */
export function nextSetup(current: Runtime, availability: RuntimesResponse | null): Runtime {
  const at = SETUP_ORDER.indexOf(current);
  for (let i = 1; i <= SETUP_ORDER.length; i++) {
    const r = SETUP_ORDER[(at + i) % SETUP_ORDER.length];
    if (!availability || availability[r] !== false) return r;
  }
  return current;
}

interface PopoverProps {
  runtime: Runtime;
  availability: RuntimesResponse | null;
  model: string;
  onRuntime: (v: Runtime) => void;
  onModel: (v: string) => void;
}

/** The landing meta line as a button; opens a small menu for setup and (non-Claude) model. */
export function SetupPopover({ runtime, availability, model, onRuntime, onModel }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelShown = model || SETUP_MODEL[runtime];

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
    // short phones: the menu runs past the fold, so bring all of it (model, effort) into view
    menuRef.current?.scrollIntoView?.({ block: 'nearest' });
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className="setup-pop"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (open && next && !wrapRef.current?.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="meta-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="land-setup-menu"
        title={runtime === 'claude' ? 'Change setup' : 'Change setup and model'}
        onClick={() => setOpen((v) => !v)}
      >
        <MetaLine agent={LEAD_AGENT} model={runtime === 'claude' ? 'Auto' : shortModelLabel(modelShown) || 'Default'} provider={providerName(runtime)} runtime={runtime} />
        <span className="meta-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div ref={menuRef} id="land-setup-menu" className="setup-menu" role="dialog" aria-label={runtime === 'claude' ? 'Setup' : 'Setup and model'}>
          <p className="setup-menu-h">setup</p>
          <div className="setup-menu-opts" role="group" aria-label="Setup">
            {SETUP_ORDER.map((r) => {
              const ok = !availability || availability[r] !== false;
              return (
                <button
                  key={r}
                  type="button"
                  className="setup-opt"
                  aria-pressed={runtime === r}
                  disabled={!ok}
                  title={ok ? SETUP_LABEL[r] : `${r} not found on PATH`}
                  onClick={() => onRuntime(r)}
                >
                  <span className="setup-opt-mark" aria-hidden="true">{runtime === r ? '●' : '○'}</span>
                  <span className="setup-opt-name">{r}</span>
                  <span className="setup-opt-desc">{SETUP_DESC[r]}</span>
                </button>
              );
            })}
          </div>
          {runtime === 'claude' ? (
            <p className="setup-menu-note">Model picked per task (Haiku)</p>
          ) : (
            <>
              <label className="setup-menu-h" htmlFor="land-model">model</label>
              <select id="land-model" value={modelShown} onChange={(e) => onModel(e.target.value)}>
                {RUNTIME_MODELS[runtime].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}
    </div>
  );
}
