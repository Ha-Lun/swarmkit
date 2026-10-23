// New session dialog: prompt, folder picker (shared with the landing page), agent, model.
import type { FleetBackend, Guard } from './api';
import { FolderPicker } from './FolderPicker';
import { AgentModelFields, useStartForm } from './StartForm';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  onClose: () => void;
  onStarted: (sessionId: string) => void;
}

export function NewSession({ backend, guard, onClose, onStarted }: Props) {
  const {
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
  } = useStartForm(backend, guard, onStarted);

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

        <AgentModelFields
          agents={agents}
          agent={agent}
          model={model}
          onAgent={setAgent}
          onModel={setModel}
          agentId="ns-agent"
          modelId="ns-model"
          layout="stack"
        />

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
