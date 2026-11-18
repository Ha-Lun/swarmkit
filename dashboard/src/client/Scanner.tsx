// Scanner: the thinking indicator. Six round nodes joined by thin links, like a tiny
// neural network, with a signal that travels from node to node (CSS keyframes, per-part
// delay, colour via --scanner-color). 'breathing'/idle = static dim nodes; 'listening' = slow amber pulse.
import type { CSSProperties } from 'react';
import type { OrbState } from './chat';

interface Props {
  state: OrbState;
  color: string;
  size: 'sm' | 'md';
}

const NODES = 6;
/** Seconds between one part (node or link) lighting up and the next, so the signal reads as travel. */
const STEP_S = 0.09;

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
      {Array.from({ length: NODES * 2 - 1 }, (_, i) => (
        <i
          key={i}
          className={i % 2 === 0 ? 'scanner-cell' : 'scanner-link'}
          style={{ animationDelay: `${i * STEP_S}s` }}
        />
      ))}
    </span>
  );
}
