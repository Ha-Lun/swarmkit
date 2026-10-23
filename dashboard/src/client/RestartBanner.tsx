// Restart reminder: a finished Bash `install.sh --pack` run means new agents exist and
// the session should be restarted so Claude can use them.
import type { AgentNode, SessionSource } from '../shared/types';
import { runsPackInstall } from './packInstall';
import { CloseIcon, WarnIcon } from './icons';

/** True when any node ran Bash with install.sh --pack and got a non-error tool_result back. */
export function packInstallDone(nodes: AgentNode[]): boolean {
  for (const n of nodes) {
    for (let i = 0; i < n.events.length; i++) {
      const e = n.events[i];
      if (e.kind !== 'tool_use' || e.tool !== 'Bash') continue;
      // The summary may be the caller's description; the full command is in the detail.
      if (!runsPackInstall(e.summary) && !runsPackInstall(e.detail ?? '')) continue;
      const key = e.toolUseId ?? e.id;
      const matched = n.events.some(
        (r, j) =>
          j > i &&
          r.kind === 'tool_result' &&
          !r.isError &&
          (r.toolUseId != null ? r.toolUseId === key : r.tool === e.tool),
      );
      if (matched) return true;
    }
  }
  return false;
}

interface Props {
  source: SessionSource;
  busy: boolean;
  onRestart: () => void;
  onDismiss: () => void;
}

export function RestartBanner({ source, busy, onRestart, onDismiss }: Props) {
  return (
    <div className="restart-banner" role="status">
      <WarnIcon size={15} />
      <div className="restart-text">
        <p>New agents were installed in this project. Restart the session so Claude can use them.</p>
        {source === 'terminal' && (
          <p className="restart-hint">
            Exit Claude Code in your terminal and start it again with --continue, or use Continue here
            once it has stopped.
          </p>
        )}
      </div>
      <div className="restart-actions">
        {source === 'page' && (
          <button type="button" className="btn btn-sm" onClick={onRestart} disabled={busy}>
            {busy ? 'Restarting…' : 'Restart session'}
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Dismiss restart reminder" onClick={onDismiss}>
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}
