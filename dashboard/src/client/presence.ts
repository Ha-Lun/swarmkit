// Tab heartbeat: tells the server whether this tab is visible, so terminal prompts are only held while someone is looking.
import type { PresenceBody } from '../shared/types';

export const PRESENCE_INTERVAL_MS = 45_000;

/** The slice of FleetBackend the heartbeat needs; the mock resolves without touching the network. */
export interface PresenceSink {
  presence(body: PresenceBody, keepalive?: boolean): Promise<unknown>;
}

interface Target {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface PresenceEnv {
  doc: Target & { visibilityState: string };
  win: Target;
  newId: () => string;
}

function defaultEnv(): PresenceEnv {
  // randomUUID exists only in secure contexts (https/localhost); plain http on a LAN/tailnet IP lacks it.
  const newId = () =>
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return { doc: document, win: window, newId };
}

/** Starts the heartbeat for this tab and returns its stop function. Network errors are swallowed. */
export function startPresence(sink: PresenceSink, env: PresenceEnv = defaultEnv()): () => void {
  const id = env.newId();
  let timer: ReturnType<typeof setInterval> | null = null;

  const isVisible = () => env.doc.visibilityState === 'visible';
  const send = (visible: boolean, keepalive?: boolean) => {
    try {
      sink.presence({ visible, id }, keepalive).catch(() => {});
    } catch {
      // the heartbeat must never break the app
    }
  };
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const report = () => {
    const visible = isVisible();
    send(visible);
    stopTimer();
    if (visible) timer = setInterval(() => send(true), PRESENCE_INTERVAL_MS);
  };
  const leave = () => {
    stopTimer();
    send(false, true);
  };

  report();
  env.doc.addEventListener('visibilitychange', report);
  env.win.addEventListener('pageshow', report);
  env.win.addEventListener('pagehide', leave);
  return () => {
    stopTimer();
    env.doc.removeEventListener('visibilitychange', report);
    env.win.removeEventListener('pageshow', report);
    env.win.removeEventListener('pagehide', leave);
  };
}
