// New session dialog: prompt, folder picker (shared with the landing page), model.
import { useEffect, useRef } from 'react';
import type { FleetBackend, Guard } from './api';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';
import { filesFromPaste } from './attachments';
import { appendTranscript, MicButton, useDictation } from './Dictation';
import { useEnterToSend } from './enterToSend';
import { FolderPicker } from './FolderPicker';
import { PendingChat } from './PendingChat';
import { SecretsButton } from './Secrets';
import { AgentModelFields, useStartForm } from './StartForm';
import type { StartDraft } from './StartForm';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  onClose: () => void;
  onStarted: (sessionId: string, handoff?: StartDraft) => void;
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
    attachments,
    starting,
    pending,
    error,
    submit,
    secretGuard,
    secretWarning,
  } = useStartForm(backend, guard, onStarted);

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation((chunk) => setPrompt((t) => appendTranscript(t, chunk)));
  const promptEnter = useEnterToSend(promptRef, () => {
    dictation.abort();
    promptRef.current?.form?.requestSubmit();
  });

  // Back on the form after a failed start: put the cursor back in the prompt.
  const wasPending = useRef(false);
  useEffect(() => {
    if (pending !== null) dictation.abort();
    if (wasPending.current && !pending) promptRef.current?.focus();
    wasPending.current = pending !== null;
  }, [pending, dictation.abort]);

  return (
    <div
      className={pending ? 'overlay is-pending' : 'overlay'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !pending) onClose();
      }}
    >
      {pending && <PendingChat draft={pending} label="Choosing a model…" />}
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="ns-title" onSubmit={(e) => {
          dictation.abort();
          void submit(e);
        }} hidden={pending !== null}>
        <h2 id="ns-title">New session</h2>

        <label htmlFor="ns-prompt">Prompt</label>
        <AttachDropzone onFiles={attachments.addFiles}>
          <textarea
            id="ns-prompt"
            ref={promptRef}
            autoFocus
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              promptEnter.onKeyDown(e);
            }}
            onPaste={(e) => {
              const files = filesFromPaste(e);
              if (files.length > 0) attachments.addFiles(files);
            }}
            placeholder="What should the fleet do?"
            title="Enter to send, Shift+Enter for a new line"
          />
        </AttachDropzone>
        <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
        <div className="prompt-attach-row">
          <AttachButton onFiles={attachments.addFiles} />
          <MicButton dictation={dictation} />
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
          onRuntime={setRuntime}
          onModel={setModel}
          modelId="ns-model"
          layout="stack"
        />

        {secretWarning}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <span className="dialog-actions-start">
            <SecretsButton onClick={() => secretGuard.open()} disabled={!cwd.trim()} />
          </span>
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
      {secretGuard.dialog}
    </div>
  );
}
