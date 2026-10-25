// New session dialog: prompt, folder picker (shared with the landing page), model.
import type { FleetBackend, Guard } from './api';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';
import { filesFromPaste } from './attachments';
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
        <AttachDropzone onFiles={attachments.addFiles}>
          <textarea
            id="ns-prompt"
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onPaste={(e) => {
              const files = filesFromPaste(e);
              if (files.length > 0) attachments.addFiles(files);
            }}
            placeholder="What should the fleet do?"
          />
        </AttachDropzone>
        <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
        <div className="prompt-attach-row">
          <AttachButton onFiles={attachments.addFiles} />
          {attachments.error && (
            <p className="attach-error" role="alert">
              {attachments.error}
            </p>
          )}
        </div>

        <p className="dialog-label" id="ns-cwd-label">Working directory</p>
        <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} labelledby="ns-cwd-label" />

        <AgentModelFields
          runtime={runtime}
          availability={availability}
          model={model}
          effort={effort}
          onRuntime={setRuntime}
          onModel={setModel}
          onEffort={setEffort}
          modelId="ns-model"
          effortId="ns-effort"
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={(!prompt.trim() && attachments.items.length === 0) || !cwd.trim() || starting}
          >
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  );
}
