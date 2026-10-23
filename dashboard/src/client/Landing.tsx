// Landing: centred "Start working" card (folder picker + prompt + options) and recent sessions.
// Shown whenever no session is selected; on phones it is the first screen.
import type { SessionSummary } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { FolderPicker } from './FolderPicker';
import { UNTRUSTED_NOTICE } from './format';
import { AgentModelFields, useStartForm } from './StartForm';
import { SessionRow } from './SessionRow';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  sessions: SessionSummary[];
  now: number;
  onSelect: (id: string) => void;
  onStarted: (id: string) => void;
}

export function Landing({ backend, guard, sessions, now, onSelect, onStarted }: Props) {
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
    <div className="landing">
      <div className="landing-inner">
        <form className="land-card" onSubmit={submit}>
          <h2>Start working</h2>
          <p className="muted land-sub">Pick a project folder, describe the task, and the fleet fans out.</p>

          <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} />

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
            placeholder="What should the fleet do?"
          />

          <AgentModelFields
            agents={agents}
            agent={agent}
            model={model}
            onAgent={setAgent}
            onModel={setModel}
            agentId="land-agent"
            modelId="land-model"
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

        <section className="land-recent" aria-label="Recent sessions">
          <h3>Recent sessions</h3>
          {sessions.length === 0 ? (
            <p className="muted land-none">Nothing yet — start your first session above.</p>
          ) : (
            sessions.map((s) => (
              <SessionRow key={s.id} session={s} now={now} onSelect={onSelect} />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
