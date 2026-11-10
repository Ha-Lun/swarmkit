// Message composer for page sessions (terminal sessions get a read-only bar instead).
// Images ride along: paste, drag-drop or the paperclip; empty text is fine with images.
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { GitInfo, FileAttachment, ImageAttachment, Runtime, SessionSummary, SlashCommandInfo } from '../shared/types';
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

const PROVIDER: Record<Runtime, string> = { claude: 'Claude', opencode: 'OpenCode Go', agy: 'Antigravity' };

/** Who serves the model: shown dim at the end of the meta line. */
export function providerName(runtime: Runtime | undefined): string {
  return PROVIDER[runtime ?? 'claude'];
}

/** "lead-dev-hybrid" -> "Lead-Dev-Hybrid". */
function agentTitle(agent: string): string {
  return agent
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

/** `Lead-Dev-Hybrid · Opus 5.5 · Claude`: small pills (agent, model, runtime tinted by lane). */
export function MetaLine({ agent, model, provider, runtime }: { agent?: string; model: string; provider: string; runtime?: Runtime }) {
  return (
    <span className="meta-pills">
      {agent && <span className="pill pill-agent">{agentTitle(agent)}</span>}
      {model && <span className="pill pill-model">{model}</span>}
      <span className="pill pill-runtime" {...(runtime ? { 'data-runtime': runtime } : {})}>{provider}</span>
    </span>
  );
}

/** Left of the row under the box: working folder and git state. */
export function ComposerWhere({ session, git }: { session: SessionSummary; git?: GitInfo }) {
  const where = session.project || shortCwd(session.cwd);
  return (
    <span className="composer-where">
      <span className="composer-where-path" title={session.cwd}>{where}</span>
      {git && <GitStatus git={git} />}
    </span>
  );
}

interface ShellProps {
  runtime: Runtime;
  /** `landing` is the big centered box on the empty page; `session` sits under a transcript. */
  variant?: 'session' | 'landing';
  onSubmit?: (e: FormEvent) => void;
  tray: ReactNode;
  menu?: ReactNode;
  onFiles: (files: File[]) => void;
  textarea: ReactNode;
  /** Inside the box, under the input. */
  meta: ReactNode;
  /** Dim text at the end of the meta line (desktop only). */
  hint?: ReactNode;
  error?: ReactNode;
  /** The dim row under the box. */
  left: ReactNode;
  right: ReactNode;
}

/** The prompt input: rounded card on the input fill, meta pills inside, one dim row below. */
export function PromptShell({ runtime, variant = 'session', onSubmit, tray, menu, onFiles, textarea, meta, hint, error, left, right }: ShellProps) {
  const body = (
    <div className="composer-col">
      {tray}
      {menu}
      <div className="composer-box">
        <AttachDropzone onFiles={onFiles}>{textarea}</AttachDropzone>
        <div className="composer-meta">
          {meta}
          {hint && <span className="composer-hint" aria-hidden="true">{hint}</span>}
        </div>
      </div>
      {error}
      <div className="composer-row">
        <div className="composer-row-left">{left}</div>
        <div className="composer-row-right">{right}</div>
      </div>
    </div>
  );
  const className = `composer${variant === 'landing' ? ' is-landing' : ''}`;
  return onSubmit ? (
    <form className={className} data-runtime={runtime} onSubmit={onSubmit}>
      {body}
    </form>
  ) : (
    <div className={className} data-runtime={runtime}>
      {body}
    </div>
  );
}

interface Props {
  session: SessionSummary;
  git?: GitInfo;
  onSend: (text: string, images: ImageAttachment[], files: FileAttachment[]) => Promise<void>;
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
    const files = attachments.toFiles();
    if (!t && images.length === 0 && files.length === 0) return;
    void run(() => onSend(t, images, files), () => {
      setText('');
      attachments.clear();
    });
  };

  const canSend = text.trim().length > 0 || attachments.items.length > 0 || attachments.files.length > 0;

  // Slash menu wins over Enter: while it is open, Enter picks the command.
  const enterToSend = useEnterToSend(ref, send, { shouldSend: () => slash.menu == null });

  const runtime = session.runtime ?? 'claude';

  return (
    <PromptShell
      runtime={runtime}
      onFiles={attachments.addFiles}
      tray={<AttachmentTray items={attachments.items} files={attachments.files} onRemove={attachments.remove} onRemoveFile={attachments.removeFile} />}
      menu={slash.menu}
      textarea={
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
          <AttachButton onFiles={attachments.addFiles} />
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
              <button type="button" className="composer-action" aria-label="Interrupt turn" title="Interrupt turn" onClick={() => void run(onInterrupt)}>
                <span className="btn-icon" aria-hidden="true">⏸</span>
                <span className="btn-text">interrupt</span>
              </button>
              <button ref={stopRef} type="button" className="composer-action is-danger" aria-label="Stop session" title="Stop session" onClick={() => setConfirming(true)}>
                <span className="btn-icon" aria-hidden="true">■</span>
                <span className="btn-text">stop</span>
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm composer-send"
                disabled={!canSend}
                aria-label={queues ? 'Queue message' : 'Send message'}
                title={queues ? 'The lead reads it when its current turn ends' : 'Steers the running turn at its next step'}
                onClick={send}
              >
                <span className="btn-icon" aria-hidden="true">↑</span>
                <span className="btn-text">{queues ? 'queue' : 'send'}</span>
              </button>
            </>
          )}
        </>
      }
    />
  );
}
