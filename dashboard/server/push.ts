// Push notifications: the subscription store ($XDG_CONFIG_HOME/swarmkit/push.json) and the
// notifier that turns ServerEvents into pushes. Sending itself lives in webpush.ts.
import type { PushEvents, PushPayload, PushSendResult, ServerEvent, SessionSummary, WorkerTask } from '../src/shared/types.ts';
import type { PushTarget, SendOptions, SendOutcome, VapidKeys } from './webpush.ts';

export interface StoredSubscription extends PushTarget {
  events: PushEvents;
  label: string;
  createdAt: number;
}

export interface PushStore {
  /** The VAPID keypair, generated and saved on first use. */
  keys(): Promise<VapidKeys>;
  list(): Promise<StoredSubscription[]>;
  get(endpoint: string): Promise<StoredSubscription | undefined>;
  /** Insert or replace by endpoint; at the cap the oldest is evicted. */
  upsert(sub: StoredSubscription): Promise<void>;
  /** True when something was removed. */
  remove(endpoint: string): Promise<boolean>;
}

/** $XDG_CONFIG_HOME/swarmkit/push.json, default ~/.config/swarmkit/push.json. */
export function pushFilePath(): string {
  throw new Error('not implemented');
}

export function createPushStore(file?: string): PushStore {
  void file;
  throw new Error('not implemented');
}

export type Sender = (target: PushTarget, payload: string, keys: VapidKeys, opts: SendOptions) => Promise<SendOutcome>;

export interface NotifierDeps {
  store: PushStore;
  send: Sender;
  /** VAPID subject passed to send. */
  subject: string;
  /** Current project/title of a session, for permission.request (which carries neither). */
  sessionInfo?: (sessionId: string) => Pick<SessionSummary, 'project' | 'title'> | undefined;
  now?: () => number;
  /** After start/baseline, events only update state for this long (default 45_000). */
  warmupMs?: number;
}

export interface PushNotifier {
  /** Feed every broadcast ServerEvent; synchronous, sends in the background, never throws. */
  observe(event: ServerEvent): void;
  /** Record current state without notifying (call once at startup). */
  baseline(sessions: SessionSummary[], workers: WorkerTask[]): void;
  /** One `test` push to one stored subscription. */
  sendTest(endpoint: string): Promise<PushSendResult>;
}

export function createPushNotifier(deps: NotifierDeps): PushNotifier {
  void deps;
  throw new Error('not implemented');
}

/** Exported for tests: the payload builder's truncation limit. */
export const MAX_TEXT = 120;
export type { PushPayload };
