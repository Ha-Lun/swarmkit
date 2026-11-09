// Landing: the empty page. A pixel wordmark over the big composer; setup, model and folder
// are chosen from the meta line and the row under the box. Shown whenever no session is selected.
import { useEffect, useRef, useState } from 'react';
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { AttachButton, AttachmentTray } from './AttachmentTray';
import { filesFromPaste } from './attachments';
import { PromptShell } from './Composer';
import { useEnterToSend } from './enterToSend';
import { UNTRUSTED_NOTICE } from './format';
import { FolderPicker } from './FolderPicker';
import { Wordmark } from './icons';
import { nextSetup, SetupPopover, useStartForm } from './StartForm';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  sessions: SessionSummary[];
  onStarted: (id: string) => void;
  // App still passes these; the empty landing shows none of them (tabs, status bar and archive cover them).
  workers: WorkerTask[];
  now: number;
  connected: boolean;
  usage: UsageReport | null;
  usageLoading: boolean;
  onRefreshUsage: () => void;
  onSelect: (id: string) => void;
  onOpenWorker: (task: WorkerTask) => void;
  onOpenWorkers: () => void;
  onOpenArchive: () => void;
}

/** `~/…/parent/name`: the home folder as `~`, long paths cut to their last two segments. */
export function shortFolder(cwd: string, home: string): string {
  const path = cwd.trim();
  if (!path) return '~';
  const underHome = home !== '' && (path === home || path.startsWith(`${home}/`));
  const parts = (underHome ? path.slice(home.length) : path).split('/').filter(Boolean);
  const root = underHome ? '~' : '';
  if (parts.length === 0) return underHome ? '~' : '/';
  if (parts.length > 2) return `${root}/…/${parts.slice(-2).join('/')}`;
  return `${root}/${parts.join('/')}`;
}

export function Landing({ backend, guard, sessions, onStarted }: Props) {
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

  const ref = useRef<HTMLTextAreaElement>(null);
  const enterToSend = useEnterToSend(ref, () => {
    ref.current?.form?.requestSubmit();
  });

  const [home, setHome] = useState('');
  useEffect(() => {
    let alive = true;
    backend
      .dirs()
      .then((l) => {
        if (alive) setHome(l.path);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const folderRef = useRef<HTMLDivElement>(null);
  const folderBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!folderRef.current?.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [pickerOpen]);

  // Cursor in the box on desktop; phones keep the keyboard down until the user taps.
  useEffect(() => {
    if (!window.matchMedia('(pointer: coarse)').matches) ref.current?.focus();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [prompt]);

  const canStart = (prompt.trim().length > 0 || attachments.items.length > 0) && cwd.trim().length > 0 && !starting;
  const untrusted = sessions.some((s) => s.cwd === cwd.trim() && s.untrustedProject);

  return (
    <div className="landing">
      <div className="landing-inner">
        <Wordmark />
        <PromptShell
          variant="landing"
          runtime={runtime}
          onSubmit={submit}
          onFiles={attachments.addFiles}
          tray={<AttachmentTray items={attachments.items} onRemove={attachments.remove} />}
          textarea={
            <textarea
              ref={ref}
              rows={1}
              aria-label="Prompt"
              placeholder={'Ask anything… "Fix broken tests"'}
              title="Enter to start, Shift+Enter for a new line, Shift+Tab to change setup"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => {
                const files = filesFromPaste(e);
                if (files.length > 0) attachments.addFiles(files);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && e.shiftKey) {
                  e.preventDefault();
                  setRuntime(nextSetup(runtime, availability));
                  return;
                }
                enterToSend.onKeyDown(e);
              }}
            />
          }
          meta={
            <SetupPopover
              runtime={runtime}
              availability={availability}
              model={model}
              effort={effort}
              onRuntime={setRuntime}
              onModel={setModel}
              onEffort={setEffort}
            />
          }
          error={
            (untrusted || error || attachments.error) && (
              <>
                {untrusted && (
                  <p className="notice" role="note">
                    {UNTRUSTED_NOTICE}
                  </p>
                )}
                {(error || attachments.error) && (
                  <p className="continue-error" role="alert">
                    {error ?? attachments.error}
                  </p>
                )}
              </>
            )
          }
          left={
            <div
              ref={folderRef}
              className="folder"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && pickerOpen) {
                  e.stopPropagation();
                  setPickerOpen(false);
                  folderBtnRef.current?.focus();
                }
              }}
            >
              <button
                ref={folderBtnRef}
                type="button"
                className="folder-btn"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                title={cwd.trim() || 'Home folder'}
                onClick={() => setPickerOpen((v) => !v)}
              >
                {shortFolder(cwd, home)}
              </button>
              {pickerOpen && (
                <div className="folder-pop" role="dialog" aria-label="Working folder">
                  <FolderPicker backend={backend} guard={guard} cwd={cwd} onCwd={setCwd} />
                  <button type="button" className="btn btn-ghost btn-sm folder-done" onClick={() => {
                    setPickerOpen(false);
                    folderBtnRef.current?.focus();
                  }}>
                    Use this folder
                  </button>
                </div>
              )}
            </div>
          }
          right={
            <>
              <span className="row-hints" aria-hidden="true">
                <span><b>shift+tab</b> setup</span>
                <span><b>enter</b> start</span>
              </span>
              <AttachButton onFiles={attachments.addFiles} />
              <button type="submit" className="btn btn-primary btn-sm" disabled={!canStart}>
                {starting ? 'starting…' : 'start'}
              </button>
            </>
          }
        />
      </div>
    </div>
  );
}
