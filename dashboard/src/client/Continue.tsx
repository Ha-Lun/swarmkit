// Continue (resume): textarea + Continue for ended sessions or terminal transcripts.
// A 409 shows the server's error message inline.
import { useEffect, useRef, useState } from 'react';
import type { GitInfo, SessionSource, SessionSummary, SlashCommandInfo } from '../shared/types';
import type { FleetBackend, Guard } from './api';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachmentTray } from './AttachmentTray';
import { ComposerWhere, MetaLine, PromptShell, providerName } from './Composer';
import { useEnterToSend } from './enterToSend';
import { modelLabel } from './format';
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
  loadCommands: () => Promise<SlashCommandInfo[]>;
}

export function Continue({ backend, guard, session, git, sessionId, source, onResumed, initialText = '', ended = false, loadCommands }: Props) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const ref = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashMenu(text, setText, loadCommands, ref);

  const submit = async () => {
    const t = text.trim();
    const images = attachments.toPayload();
    const files = attachments.toFiles();
    if ((!t && images.length === 0 && files.length === 0) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await guard(
        backend.resume(sessionId, {
          text: t,
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

  const canSend = text.trim().length > 0 || attachments.items.length > 0;

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

  return (
    <PromptShell
      runtime={runtime}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onFiles={attachments.addFiles}
      tray={<AttachmentTray items={attachments.items} files={attachments.files} onRemove={attachments.remove} onRemoveFile={attachments.removeFile} />}
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
            slash.onChange();
          }}
          onPaste={(e) => {
            const files = filesFromPaste(e);
            if (files.length > 0) attachments.addFiles(files);
          }}
          onKeyDown={(e) => {
            if (slash.onKeyDown(e)) return;
            if (enterToSend.onKeyDown(e)) return;
          }}
        />
      }
      meta={<MetaLine agent={session.agent} model={modelLabel(session.model)} provider={providerName(runtime)} runtime={runtime} />}
      hint="enter send · shift+enter newline"
      error={
        (attachments.error || error) && (
          <p className="continue-error" role="alert">
            {attachments.error ?? error}
          </p>
        )
      }
      left={<ComposerWhere session={session} git={git} />}
      right={
        <>
          {ended && <span className="continue-hint">Session has ended; use Continue.</span>}
          {source === 'terminal' && <span className="continue-hint">Continuing makes it page-owned.</span>}
          <AttachButton onFiles={attachments.addFiles} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!canSend || busy}>
            {busy ? 'continuing…' : 'continue'}
          </button>
        </>
      }
    />
  );
}
