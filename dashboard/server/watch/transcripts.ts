import type { ServerEvent, SessionDetail, SessionSummary } from '../../src/shared/types.ts';

export interface WatcherOptions {
  /** Defaults to ~/.claude/projects. */
  root?: string;
  /** Only sessions modified within this many ms are listed; default 24 h. */
  maxAgeMs?: number;
  emit: (e: ServerEvent) => void;
  /** True for session ids owned by the SDK manager (page sessions): the watcher skips them. */
  skip: (sessionId: string) => boolean;
}

export class TranscriptWatcher {
  constructor(opts: WatcherOptions) {}
  /** Starts scanning and tailing; idempotent. */
  start(): void {}
  stop(): void {}
  /** Terminal sessions, most recently updated first. */
  list(): SessionSummary[] {
    return [];
  }
  /** Parses the session lazily on first call, then keeps tailing it. */
  async get(sessionId: string): Promise<SessionDetail | undefined> {
    return undefined;
  }
  /** Recent cwds from transcripts, most recent first. */
  recentCwds(): string[] {
    return [];
  }
}
