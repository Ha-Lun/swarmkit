// Message composer for page sessions (terminal sessions get a read-only bar instead).
// Images ride along: paste, drag-drop or the paperclip; empty text is fine with images.
import { useEffect, useRef, useState } from 'react';
import type { GitInfo, ImageAttachment, SessionSummary, SlashCommandInfo } from '../shared/types';
import { filesFromPaste, useAttachments } from './attachments';
import { AttachButton, AttachDropzone, AttachmentTray } from './AttachmentTray';
import { useEnterToSend } from './enterToSend';
import { modelLabel } from './format';
import { useSlashMenu } from './SlashMenu';

/** Last two path segments: enough to recognise a checkout without eating the footer line. */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
}

/** Branch, dirty count, ahead/behind and worktree marker. `compact` keeps just branch and dirty (topbar chip). */
export function GitStatus({ git, compact = false }: { git: GitInfo; compact?: boolean }) {
  return (
    <span className="git-status" title={git.detached ? `Detached HEAD at ${git.branch}` : `Branch ${git.branch}`}>
      <span aria-hidden="true">⎇</span>
      <span className="sr-only">Branch </span>
      {git.branch}
      {git.dirty > 0 && (
        <span className="git-dirty" title={`${git.dirty} changed file${git.dirty === 1 ? '' : 's'}`}>
          <span aria-hidden="true">●</span>
          {git.dirty}
          <span className="sr-only"> changed files</span>
        </span>
      )}
      {!compact && git.ahead > 0 && (
        <span title={`${git.ahead} ahead of upstream`}>
          <span aria-hidden="true">↑</span>
          {git.ahead}
          <span className="sr-only"> ahead</span>
        </span>
      )}
      {!compact && git.behind > 0 && (
        <span title={`${git.behind} behind upstream`}>
          <span aria-hidden="true">↓</span>
          {git.behind}
          <span className="sr-only"> behind</span>
        </span>
      )}
      {!compact && git.worktreeOf && (
        <span className="git-worktree" title={`Worktree of ${git.worktreeOf}`}>
          worktree
        </span>
      )}
    </span>
  );
}

/** One muted line under the input: agent and model on the left, project and git on the right. */
export function ComposerFooter({ session, git }: { session: SessionSummary; git?: GitInfo }) {
  const left = [session.agent, modelLabel(session.model)].filter(Boolean).join(' · ');
  const where = session.project || shortCwd(session.cwd);
  return (
    <div className="composer-foot">
      <span className="composer-foot-agent">{left}</span>
      <span className="composer-foot-where">
        <span title={session.cwd}>{where}</span>
        {git && <GitStatus git={git} />}
      </span>
    </div>
  );
}

interface Props {
  session: SessionSummary;
  git?: GitInfo;
  onSend: (text: string, images: ImageAttachment[]) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onStop: () => void;
  loadCommands: () => Promise<SlashCommandInfo[]>;
}

export function Composer({ session, git, onSend, onInterrupt, onStop, loadCommands }: Props) {
  const queues = session.runtime === 'opencode' || session.runtime === 'agy';
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const cancelStop = () => {
    returnFocus.current = true;
    setConfirming(false);
  };
  // The Stop button only exists again after the confirm closes, so focus it post-render.
  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      stopRef.current?.focus();
    }
  }, [confirming]);
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const attachments = useAttachments();

  const slash = useSlashMenu(text, setText, loadCommands, ref);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>, onOk?: () => void) => {
    setError(null);
    try {
      await fn();
      onOk?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    }
  };

  const send = () => {
    const t = text.trim();
    const images = attachments.toPayload();
    if (!t && images.length === 0) return;
    void run(() => onSend(t, images), () => {
      setText('');
      attachments.clear();
    });
  };

  const canSend = text.trim().length > 0 || attachments.items.length > 0;

  // Slash menu wins over Enter: while it is open, Enter picks the command.
  const enterToSend = useEnterToSend(ref, send, { shouldSend: () => slash.menu == null });

  return (
    <div className="composer" data-runtime={session.runtime ?? 'claude'}>
      <div className="composer-col">
        <AttachmentTray items={attachments.items} onRemove={attachments.remove} />
        {slash.menu}
        <div className="composer-box">
          <AttachDropzone onFiles={attachments.addFiles}>
            <textarea
              ref={ref}
              rows={1}
              aria-label="Message the session"
              placeholder={queues ? 'Queue a message for after this turn…' : 'Ask or steer while it works…'}
              title="Enter to send, Shift+Enter for a new line"
              {...slash.inputProps}
              value={text}
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
          </AttachDropzone>
          <div className="composer-actions">
            <AttachButton onFiles={attachments.addFiles} />
            <span className="composer-hint" aria-hidden="true">Enter to send · Shift+Enter for a new line</span>
            {confirming ? (
              <span
                className="composer-confirm"
                role="group"
                aria-label="Confirm stop"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelStop();
                }}
              >
                <span className="composer-confirm-text">Stop this session? The lead and its running workers end.</span>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => {
                    setConfirming(false);
                    onStop();
                  }}
                >
                  Stop session
                </button>
                <button type="button" className="btn btn-ghost btn-sm" autoFocus onClick={cancelStop}>
                  Cancel
                </button>
              </span>
            ) : (
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(onInterrupt)}>
                  Interrupt
                </button>
                <button
                  ref={stopRef}
                  type="button"
                  className="btn btn-danger-ghost btn-sm"
                  onClick={() => setConfirming(true)}
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!canSend}
                  title={queues ? 'The lead reads it when its current turn ends' : 'Steers the running turn at its next step'}
                  onClick={send}
                >
                  {queues ? 'Queue' : 'Send'}
                </button>
              </>
            )}
          </div>
        </div>
        {(attachments.error || error) && (
          <p className="continue-error" role="alert">
            {attachments.error ?? error}
          </p>
        )}
        <ComposerFooter session={session} git={git} />
      </div>
    </div>
  );
}
