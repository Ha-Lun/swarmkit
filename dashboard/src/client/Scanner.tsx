// Scanner: the thinking indicator. Six small cells with a highlight that travels
// back and forth (CSS keyframes, per-cell delay, colour via --scanner-color).
// 'breathing'/idle = static dim cells; 'listening' = slow amber pulse.
import type { CSSProperties } from 'react';
import type { OrbState } from './chat';

interface Props {
  state: OrbState;
  color: string;
  size: 'sm' | 'md';
}

const CELLS = 6;

export function Scanner({ state, color, size }: Props) {
  const idle = state === 'breathing';
  const listening = state === 'listening';
  // Listening always pulses amber so "waiting for you" reads the same everywhere.
  const effective = listening ? 'var(--amber)' : color;
  const cls = `scanner is-${size}${idle ? ' is-idle' : ''}${listening ? ' is-listening' : ''}`;
  return (
    <span
      className={cls}
      role="img"
      aria-hidden="true"
      style={{ '--scanner-color': effective } as CSSProperties}
    >
      {Array.from({ length: CELLS }, (_, i) => (
        <i key={i} className="scanner-cell" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}
