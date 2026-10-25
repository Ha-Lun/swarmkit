// Small wrapper around the thinking-orbs indicator (reduced-motion aware).
import { useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { OrbState } from 'thinking-orbs';

interface Props {
  state: OrbState;
  color: string;
  size: 20 | 32;
}

export function Orb({ state, color, size }: Props) {
  const [paused] = useState(() => {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  return (
    <span className="orb" aria-hidden="true" style={{ width: size, height: size }}>
      <ThinkingOrb theme="dark" dotSize={1.3} state={state} size={size} color={color} paused={paused} />
    </span>
  );
}
