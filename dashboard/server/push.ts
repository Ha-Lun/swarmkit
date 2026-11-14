// Push notifications: the subscription store ($XDG_CONFIG_HOME/swarmkit/push.json) and the
// notifier that turns ServerEvents into pushes. Sending itself lives in webpush.ts.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PushEvents, PushPayload, PushSendResult, ServerEvent, SessionSummary, Status, WorkerTask } from '../src/shared/types.ts';
import { generateVapidKeys, type PushTarget, type SendOptions, type SendOutcome, type VapidKeys } from './webpush.ts';

const MAX_SUBSCRIPTIONS = 20;
const DEFAULT_WARMUP_MS = 45_000;
const RECENT_WORKER_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_NOTIFICATIONS = 30;
const PUSH_TTL_S = 3600;

/** Serialises concurrent writers so overlapping updates cannot clobber each other. */
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn);
  // A failure must not jam the chain for later callers.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function configBase(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
}

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
  return path.join(configBase(), 'swarmkit', 'push.json');
}

interface StoreData {
  vapid?: VapidKeys;
  subscriptions: StoredSubscription[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isVapidKeys(v: unknown): v is VapidKeys {
  if (!isPlainObject(v)) return false;
  return typeof v.publicKey === 'string' && v.publicKey.length > 0 && typeof v.privateKey === 'string' && v.privateKey.length > 0;
}

function isStoredSubscription(v: unknown): v is StoredSubscription {
  if (!isPlainObject(v)) return false;
  if (typeof v.endpoint !== 'string' || v.endpoint.length === 0) return false;
  if (typeof v.label !== 'string') return false;
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return false;
  if (!isPlainObject(v.keys) || typeof v.keys.p256dh !== 'string' || typeof v.keys.auth !== 'string') return false;
  if (
    !isPlainObject(v.events) ||
    typeof v.events.waiting !== 'boolean' ||
    typeof v.events.finished !== 'boolean' ||
    typeof v.events.error !== 'boolean' ||
    typeof v.events.workers !== 'boolean'
  ) {
    return false;
  }
  return true;
}

function cloneSubscription(sub: StoredSubscription): StoredSubscription {
  return {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    events: {
      waiting: sub.events.waiting,
      finished: sub.events.finished,
      error: sub.events.error,
      workers: sub.events.workers,
    },
    label: sub.label,
    createdAt: sub.createdAt,
  };
}

function parseStoreData(raw: string): StoreData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  let vapid: VapidKeys | undefined;
  if (parsed.vapid !== undefined) {
    if (!isVapidKeys(parsed.vapid)) return null;
    vapid = { publicKey: parsed.vapid.publicKey, privateKey: parsed.vapid.privateKey };
  }
  if (parsed.subscriptions !== undefined && !Array.isArray(parsed.subscriptions)) return null;
  const subscriptions: StoredSubscription[] = [];
  if (Array.isArray(parsed.subscriptions)) {
    for (const item of parsed.subscriptions) {
      if (isStoredSubscription(item)) subscriptions.push(cloneSubscription(item));
    }
  }
  return vapid ? { vapid, subscriptions } : { subscriptions };
}

async function writeStoreFile(file: string, data: StoreData): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
  await rename(tmp, file);
}

export function createPushStore(file = pushFilePath(), generate: () => VapidKeys = generateVapidKeys): PushStore {
  let cached: StoreData | undefined;
  let loadPromise: Promise<StoreData> | undefined;

  async function readFromDisk(): Promise<StoreData> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { subscriptions: [] };
      }
      console.warn('push store read failed:', err);
      return { subscriptions: [] };
    }
    const parsed = parseStoreData(raw);
    if (!parsed) {
      console.warn(`push store file ${file} is corrupt; treating as empty`);
      return { subscriptions: [] };
    }
    return parsed;
  }

  function load(): Promise<StoreData> {
    if (cached) return Promise.resolve(cached);
    if (!loadPromise) {
      loadPromise = readFromDisk()
        .then((data) => {
          cached = data;
          return data;
        })
        .finally(() => {
          loadPromise = undefined;
        });
    }
    return loadPromise;
  }

  return {
    async keys(): Promise<VapidKeys> {
      const current = await load();
      if (current.vapid) return { ...current.vapid };
      return enqueueWrite(async () => {
        const latest = await load();
        if (latest.vapid) return { ...latest.vapid };
        const generated = generate();
        const vapid: VapidKeys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
        const next: StoreData = { vapid, subscriptions: latest.subscriptions };
        await writeStoreFile(file, next);
        cached = next;
        return { ...vapid };
      });
    },

    async list(): Promise<StoredSubscription[]> {
      const current = await load();
      return current.subscriptions.map(cloneSubscription);
    },

    async get(endpoint: string): Promise<StoredSubscription | undefined> {
      const current = await load();
      const found = current.subscriptions.find(s => s.endpoint === endpoint);
      return found ? cloneSubscription(found) : undefined;
    },

    async upsert(sub: StoredSubscription): Promise<void> {
      await enqueueWrite(async () => {
        const current = await load();
        const subs = current.subscriptions.map(cloneSubscription);
        const idx = subs.findIndex(s => s.endpoint === sub.endpoint);
        const existing = idx >= 0 ? subs[idx] : undefined;
        if (existing) {
          subs[idx] = { ...cloneSubscription(sub), createdAt: existing.createdAt };
        } else {
          while (subs.length >= MAX_SUBSCRIPTIONS) {
            let oldestIdx = 0;
            for (let i = 1; i < subs.length; i++) {
              const cur = subs[i];
              const oldest = subs[oldestIdx];
              if (cur && oldest && cur.createdAt < oldest.createdAt) oldestIdx = i;
            }
            subs.splice(oldestIdx, 1);
          }
          subs.push(cloneSubscription(sub));
        }
        const next: StoreData = current.vapid ? { vapid: current.vapid, subscriptions: subs } : { subscriptions: subs };
        await writeStoreFile(file, next);
        cached = next;
      });
    },

    async remove(endpoint: string): Promise<boolean> {
      return enqueueWrite(async () => {
        const current = await load();
        const idx = current.subscriptions.findIndex(s => s.endpoint === endpoint);
        if (idx < 0) return false;
        const subs = current.subscriptions.filter(s => s.endpoint !== endpoint).map(cloneSubscription);
        const next: StoreData = current.vapid ? { vapid: current.vapid, subscriptions: subs } : { subscriptions: subs };
        await writeStoreFile(file, next);
        cached = next;
        return true;
      });
    },
  };
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

function truncateText(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

function makePayload(title: string, body: string, tag: string, url: string): PushPayload {
  return {
    title: truncateText(title),
    body: truncateText(body),
    tag,
    url,
  };
}

function formatSessionLabel(info?: Pick<SessionSummary, 'project' | 'title'>): string | undefined {
  if (!info) return undefined;
  if (info.project && info.title) return `${info.project}: ${info.title}`;
  return info.project || info.title || undefined;
}

function workerKey(w: Pick<WorkerTask, 'lane' | 'repo' | 'slug'>): string {
  return `${w.lane}/${w.repo}/${w.slug}`;
}

function workerTitle(state: 'ok' | 'not-ok' | 'unfinished'): string {
  if (state === 'ok') return 'Worker ok';
  if (state === 'not-ok') return 'Worker NOT ok';
  return 'Worker stopped';
}

export function createPushNotifier(deps: NotifierDeps): PushNotifier {
  const now = deps.now ?? Date.now;
  const warmupMs = deps.warmupMs ?? DEFAULT_WARMUP_MS;
  const lastStatus = new Map<string, Status>();
  const workerStates = new Map<string, WorkerTask['state']>();
  const openWaits = new Set<string>();
  const sentTimestamps: number[] = [];
  let startedAt = now();

  function inWarmup(): boolean {
    return now() - startedAt < warmupMs;
  }

  function allowNotification(): boolean {
    const t = now();
    while (sentTimestamps.length > 0 && t - sentTimestamps[0]! >= RATE_WINDOW_MS) {
      sentTimestamps.shift();
    }
    if (sentTimestamps.length >= RATE_MAX_NOTIFICATIONS) return false;
    sentTimestamps.push(t);
    return true;
  }

  async function fanOut(kind: keyof PushEvents, payload: PushPayload): Promise<void> {
    const subs = await deps.store.list();
    const targets = subs.filter(sub => sub.events[kind]);
    if (targets.length === 0) return;
    const keys = await deps.store.keys();
    const body = JSON.stringify(payload);
    const opts: SendOptions = { subject: deps.subject, urgency: 'high', ttl: PUSH_TTL_S };
    await Promise.all(
      targets.map(async (sub) => {
        try {
          const outcome = await deps.send(sub, body, keys, opts);
          if (outcome.result === 'gone') {
            await deps.store.remove(sub.endpoint);
          }
        } catch (err) {
          console.warn('push send failed:', err);
        }
      }),
    );
  }

  function notify(kind: keyof PushEvents, payload: PushPayload): void {
    if (inWarmup()) return;
    if (!allowNotification()) return;
    void fanOut(kind, payload).catch((err) => {
      console.warn('push notify failed:', err);
    });
  }

  function handleSessionUpsert(session: SessionSummary): void {
    const prev = lastStatus.get(session.id);
    const next = session.status;
    lastStatus.set(session.id, next);
    if (prev === undefined || prev === next) return;

    const tag = session.id;
    const url = `/?session=${encodeURIComponent(session.id)}`;
    const body = formatSessionLabel(session) ?? session.id;

    if (next === 'waiting') {
      if (!openWaits.has(session.id)) {
        openWaits.add(session.id);
        notify('waiting', makePayload('Needs you', body, tag, url));
      }
      return;
    }

    openWaits.delete(session.id);

    if ((prev === 'running' || prev === 'waiting') && (next === 'idle' || next === 'done')) {
      notify('finished', makePayload('Finished', body, tag, url));
    } else if (next === 'error') {
      notify('error', makePayload('Error', body, tag, url));
    }
  }

  function handlePermissionRequest(event: Extract<ServerEvent, { type: 'permission.request' }>): void {
    const req = event.request;
    if (openWaits.has(req.sessionId)) return;
    openWaits.add(req.sessionId);

    const suffix = req.kind === 'question' ? ': question' : req.kind === 'plan' ? ': plan approval' : '';
    const title = `Needs you${suffix}`;
    const who = formatSessionLabel(deps.sessionInfo?.(req.sessionId)) ?? 'a session';
    const body = who + (req.title ? ` — ${req.title}` : '');
    const url = `/?session=${encodeURIComponent(req.sessionId)}`;
    notify('waiting', makePayload(title, body, req.sessionId, url));
  }

  function handleWorkersUpdate(workers: WorkerTask[]): void {
    const t = now();
    for (const worker of workers) {
      const key = workerKey(worker);
      const prev = workerStates.get(key);
      const next = worker.state;
      workerStates.set(key, next);
      if (next === 'running') continue;

      const fromRunning = prev === 'running';
      const freshEnded =
        prev === undefined &&
        !inWarmup() &&
        (next === 'ok' || next === 'not-ok') &&
        worker.endedAt !== undefined &&
        t - worker.endedAt <= RECENT_WORKER_MS;

      if (!fromRunning && !freshEnded) continue;
      const body = `${worker.lane}/${worker.slug}` + (worker.model ? ` · ${worker.model}` : '');
      notify('workers', makePayload(workerTitle(next), body, `worker:${key}`, '/?workers=1'));
    }
  }

  return {
    observe(event: ServerEvent): void {
      try {
        switch (event.type) {
          case 'session.upsert':
            handleSessionUpsert(event.session);
            break;
          case 'session.removed':
            lastStatus.delete(event.sessionId);
            openWaits.delete(event.sessionId);
            break;
          case 'permission.request':
            handlePermissionRequest(event);
            break;
          case 'permission.resolved':
            openWaits.delete(event.sessionId);
            break;
          case 'workers.update':
            handleWorkersUpdate(event.workers);
            break;
          case 'hello':
          case 'node.upsert':
          case 'node.event':
            break;
        }
      } catch (err) {
        console.warn('push observe failed:', err);
      }
    },

    baseline(sessions: SessionSummary[], workers: WorkerTask[]): void {
      lastStatus.clear();
      workerStates.clear();
      openWaits.clear();
      for (const s of sessions) {
        lastStatus.set(s.id, s.status);
      }
      for (const w of workers) {
        workerStates.set(workerKey(w), w.state);
      }
      startedAt = now();
    },

    async sendTest(endpoint: string): Promise<PushSendResult> {
      const sub = await deps.store.get(endpoint);
      if (!sub) return 'error';
      const payload: PushPayload = {
        title: 'SwarmKit',
        body: 'Test notification',
        tag: 'test',
        url: '/',
        test: true,
      };
      try {
        const keys = await deps.store.keys();
        const outcome = await deps.send(sub, JSON.stringify(payload), keys, {
          subject: deps.subject,
          urgency: 'high',
          ttl: PUSH_TTL_S,
        });
        if (outcome.result === 'gone') {
          await deps.store.remove(endpoint);
        }
        return outcome.result;
      } catch (err) {
        console.warn('push sendTest failed:', err);
        return 'error';
      }
    },
  };
}

/** Exported for tests: the payload builder's truncation limit. */
export const MAX_TEXT = 120;
export type { PushPayload };
