// Continue (resume): textarea + Continue for ended sessions or terminal transcripts.
// A 409 shows the server's error message inline.
import { useEffect, useRef, useState } from 'react';
import type { GitInfo, SessionSource, SessionSummary, SlashCommandInfo } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachmentTray } from './AttachmentTray';
import { ComposerWhere, MetaLine, PromptShell, providerName } from './Composer';
import { appendTranscript, MicButton, useDictation } from './Dictation';
import { useEnterToSend } from './enterToSend';
import { canUseOpus, modelLabel } from './format';
import { useSecretGuard } from './Secrets';
import { useSlashMenu } from './SlashMenu';

interface Props {
  backend: FleetBackend;
  guard: Guard;
  session: SessionSummary;
  git?: GitInfo;
  sessionId: string;
  source: SessionSource;
  onResumed: (sessionId: string) => void;
  /** Text carried over from the composer when the session turned out to be over. */
  initialText?: string;
  /** The server just refused a message because the session has ended. */
  ended?: boolean;
  /** Continue as a copy: a new page session, the terminal source session untouched. */
  fork?: boolean;
  loadCommands: () => Promise<SlashCommandInfo[]>;
  /** "Use Opus" for the next resume; owned by App so it survives the remount when the draft moves here. */
  useOpus: boolean;
  onUseOpus: (on: boolean) => void;
}

export function Continue({ backend, guard, session, git, sessionId, source, onResumed, initialText = '', ended = false, fork = false, loadCommands, useOpus, onUseOpus }: Props) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const secretGuard = useSecretGuard(session.cwd, session.id);
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu(text, setText, loadCommands, ref);
  const dictation = useDictation((chunk) => {
    setText((t) => appendTranscript(t, chunk));
    secretGuard.reset();
    slash.onChange();
  });

  const opusOffered = canUseOpus(session);

  const submit = async (force = false) => {
    dictation.abort();
    const t = text.trim();
    const images = fork ? [] : attachments.toPayload();
    const files = fork ? [] : attachments.toFiles();
    if ((!t && images.length === 0 && files.length === 0) || busy) return;
    if (!force && secretGuard.check(t)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await guard(
        backend.resume(sessionId, {
          text: t,
          ...(fork ? { fork: true } : {}),
          ...(opusOffered && useOpus ? { model: 'opus' } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(files.length > 0 ? { files } : {}),
        }),
      );
      if (res) {
        attachments.clear();
        onResumed(res.sessionId);
      } else setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not continue this session.');
      setBusy(false);
    }
  };

  // A fork is prompt text only: it cannot carry attachments.
  const canSend = fork
    ? text.trim().length > 0
    : text.trim().length > 0 || attachments.items.length > 0 || attachments.files.length > 0;

  // Slash menu wins over Enter: while it is open, Enter picks the command.
  const enterToSend = useEnterToSend(ref, () => {
    void submit();
  }, { shouldSend: () => slash.menu == null });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const runtime = session.runtime ?? 'claude';
  const tray = fork ? null : <AttachmentTray items={attachments.items} files={attachments.files} onRemove={attachments.remove} onRemoveFile={attachments.removeFile} />;

  return (
    <>
      <PromptShell
        runtime={runtime}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onFiles={fork ? () => { /* a fork is text only */ } : attachments.addFiles}
        tray={tray}
        menu={slash.menu}
        textarea={
          <textarea
            ref={ref}
            rows={1}
            aria-label="Continue this session"
            placeholder="Continue this session…"
            title="Enter to send, Shift+Enter for a new line"
            value={text}
            {...slash.inputProps}
            onChange={(e) => {
              setText(e.target.value);
              secretGuard.reset();
              slash.onChange();
            }}
            onPaste={(e) => {
              if (fork) return; // a fork is text only
              const files = filesFromPaste(e);
              if (files.length > 0) attachments.addFiles(files);
            }}
            onKeyDown={(e) => {
              if (slash.onKeyDown(e)) return;
              if (enterToSend.onKeyDown(e)) return;
            }}
          />
        }
        aside={
          opusOffered && (
            <label className="opus-toggle">
              <input type="checkbox" checked={useOpus} onChange={(e) => onUseOpus(e.target.checked)} />
              <span className="opus-toggle-name">Use Opus</span>
              <span className="opus-toggle-hint">next message re-reads the chat at Opus price</span>
            </label>
          )
        }
        meta={<MetaLine agent={session.agent} model={modelLabel(session.model)} provider={providerName(runtime)} runtime={runtime} />}
        hint="enter send · shift+enter newline"
        error={
          <>
            {secretGuard.warning(() => text, () => {
              secretGuard.reset();
              void submit(true);
            })}
            {(attachments.error || error) && (
              <p className="continue-error" role="alert">
                {attachments.error ?? error}
              </p>
            )}
          </>
        }
        left={<ComposerWhere session={session} git={git} />}
        right={
          <>
            {ended && <span className="continue-hint">Session has ended; use Continue.</span>}
            {fork ? (
              <span className="continue-hint">Continues as a copy; the terminal session is untouched</span>
            ) : (
              source === 'terminal' && <span className="continue-hint">Continuing makes it page-owned.</span>
            )}
            <MicButton dictation={dictation} />
            {!fork && <AttachButton onFiles={attachments.addFiles} />}
            <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend || busy}>
              {busy ? 'continuing…' : 'continue'}
            </button>
          </>
        }
      />
      {secretGuard.dialog}
    </>
  );
}
