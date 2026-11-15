// Plan-limit fallback notices: the end-of-chat note on the Claude session that hit its limit,
// and the "continued from" line on the session that took over.
import type { LimitReached, Runtime, SessionSummary } from '../shared/types';
import { fmtLimitReset } from './format';
import { WarnIcon } from './icons';

const LANE_LABEL: Record<Runtime, string> = { claude: 'Claude', opencode: 'OpenCode', agy: 'agy' };

interface LimitProps {
  limit: LimitReached;
  now: number;
  onSelectSession: (id: string) => void;
}

export function LimitNotice({ limit, now, onSelectSession }: LimitProps) {
  const reset = limit.resetsAt ? fmtLimitReset(limit.resetsAt, now) : '';
  const { fallback } = limit;
  return (
    <div className="limit-notice" role="status">
      <WarnIcon size={15} />
      <p className="limit-text">
        Claude plan limit reached{reset ? ` (resets ${reset})` : ''}.
        {!fallback && <span className="limit-sub"> No fallback lane was free. Resume after the reset.</span>}
      </p>
      {fallback && (
        <button type="button" className="btn btn-ghost btn-sm limit-go" onClick={() => onSelectSession(fallback.sessionId)}>
          Continued on {LANE_LABEL[fallback.runtime]} <span aria-hidden="true">→</span>
        </button>
      )}
    </div>
  );
}

interface FromProps {
  from: NonNullable<SessionSummary['fallbackOf']>;
  onSelectSession: (id: string) => void;
}

export function ContinuedFrom({ from, onSelectSession }: FromProps) {
  return (
    <button type="button" className="chat-from" onClick={() => onSelectSession(from.sessionId)}>
      <span className="chat-from-label">
        Continued from <b>{from.title}</b>
      </span>
      <span aria-hidden="true">←</span>
    </button>
  );
}
