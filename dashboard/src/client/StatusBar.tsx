// StatusBar: the dim one-line footer, as in the OpenCode TUI. Left: connection state, Workers
// and Archive buttons. Right: Claude 5-hour and OpenCode Go usage, then the dashboard version.
import type { SessionSummary, UsageReport, WorkerTask } from '../shared/types';
import { version } from '../../package.json';
import { fmtResetIn, goPillModel, usageTone } from './format';

interface Props {
  sessions: SessionSummary[];
  workers: WorkerTask[];
  connected: boolean;
  usage?: UsageReport;
  onOpenWorkers: () => void;
  onOpenArchive: () => void;
}

export function StatusBar({ sessions, workers, connected, usage, onOpenWorkers, onOpenArchive }: Props) {
  const runningWorkers = workers.filter((w) => w.state === 'running').length;
  const archived = sessions.filter((s) => s.resumable === true).length;

  const fiveHour = usage?.claude.available === true ? usage.claude.fiveHour : undefined;
  const utilization = fiveHour?.utilization ?? null;
  const claudePct = utilization == null ? null : Math.min(100, Math.max(0, Math.round(utilization)));
  const resetLabel = fiveHour?.resetsAt ? fmtResetIn(fiveHour.resetsAt) : '';
  const claudeLabel =
    claudePct == null
      ? undefined
      : `Claude 5-hour window ${claudePct}%${resetLabel ? `, resets ${resetLabel}` : ''}`;

  const go = goPillModel(usage?.opencode.limits);

  return (
    <footer className="statusbar">
      <span className="status-conn" title={connected ? 'Live' : 'Reconnecting…'}>
        <i className={`dot ${connected ? 'st-done' : 'st-error'}`} aria-hidden="true" />
        <span className="status-conn-label">{connected ? 'connected' : 'reconnecting'}</span>
      </span>
      <nav className="status-nav" aria-label="Dashboard">
        <button type="button" className="status-btn" onClick={onOpenWorkers} aria-label={`Workers, ${runningWorkers} running`}>
          Workers <b title={`${runningWorkers} running`}>{runningWorkers}</b>
        </button>
        <button type="button" className="status-btn" onClick={onOpenArchive} aria-label={`Archive, ${archived} resumable`}>
          Archive <b title={`${archived} resumable ended sessions`}>{archived}</b>
        </button>
      </nav>
      <span className="status-spacer" />
      {claudePct != null && (
        <span
          className={`status-usage tone-${usageTone(utilization)}`}
          aria-label={claudeLabel}
          title={resetLabel ? `resets ${resetLabel}` : undefined}
        >
          claude 5h <b>{claudePct}%</b>
        </span>
      )}
      {go && (
        <span className={`status-usage tone-${go.tone}`} aria-label={go.label} title={go.label}>
          go <b>{go.pct == null ? '—' : `${go.pct}%`}</b>
        </span>
      )}
      <span className="status-ver" title="SwarmKit dashboard version">
        v{version}
      </span>
    </footer>
  );
}
