// Web Push client: permission, subscription and the device label. The HTTP calls live on
// FleetBackend (api.ts) so the mock can stub them; everything here that touches the
// browser is only called from a click handler or an effect, never at import time.
import type { PushEvents, PushSubscriptionBody } from '../shared/types';
import type { FleetBackend } from './api';

export const DEFAULT_PUSH_EVENTS: PushEvents = { waiting: true, finished: true, error: true, workers: true };

const READY_TIMEOUT_MS = 10_000;

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext
  );
}

/** Register /sw.js once. Failure leaves push unavailable but must not break the app. */
export function registerWorker(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.register('/sw.js').then(
    (reg) => reg,
    () => undefined,
  );
}

/** base64url (the server's VAPID key) to the bytes applicationServerKey wants. */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when a subscription's applicationServerKey is the server's current key. */
export function sameKey(existing: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  return a.length === key.length && a.every((v, i) => v === key[i]);
}

/** Short device name for the server's subscription list, e.g. "Android Chrome" (at most 60 chars). */
export function deviceLabel(ua: string): string {
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'Desktop';
  const browser = /SamsungBrowser/i.test(ua)
    ? 'Samsung Internet'
    : /Edg(e|A|iOS)?\//.test(ua)
      ? 'Edge'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Browser';
  return `${os} ${browser}`.slice(0, 60);
}

export interface DeepLink {
  session?: string;
  workers?: boolean;
}

/** `?session=<id>` / `?workers=1` from a URL (absolute, or a path like '/?workers=1'); null when neither is set. */
export function parseDeepLink(url: string): DeepLink | null {
  let params: URLSearchParams;
  try {
    params = new URL(url, 'https://dashboard.invalid').searchParams;
  } catch {
    return null;
  }
  const session = params.get('session');
  if (session) return { session };
  if (params.get('workers') === '1') return { workers: true };
  return null;
}

/** The current URL's query without the deep-link params, so a reload does not reopen the link. */
export function stripDeepLink(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('session');
  params.delete('workers');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await registerWorker();
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('The notification service did not start')), READY_TIMEOUT_MS),
  );
  return Promise.race([navigator.serviceWorker.ready, timeout]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

function toBody(sub: PushSubscription): PushSubscriptionBody {
  const json = sub.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) throw new Error('The browser returned an incomplete subscription');
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

function post(backend: FleetBackend, sub: PushSubscription, events: PushEvents): Promise<unknown> {
  return backend.pushSubscribe({ subscription: toBody(sub), events, label: deviceLabel(navigator.userAgent) });
}

export type EnableFailure = 'denied' | 'dismissed';

export class PushPermissionError extends Error {
  constructor(readonly reason: EnableFailure) {
    super(reason === 'denied' ? 'Notifications are blocked in browser settings' : 'Notification permission was not granted');
    this.name = 'PushPermissionError';
  }
}

/**
 * Ask permission, subscribe and register with the server. Call it straight from the click
 * handler: Android only shows the permission prompt while the tap's user activation is
 * live, so requestPermission() is the first thing that runs, before any fetch.
 */
export async function enable(backend: FleetBackend, events: PushEvents): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushPermissionError(permission === 'denied' ? 'denied' : 'dismissed');

  const [{ publicKey }, reg] = await Promise.all([backend.pushKey(), registration()]);
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await post(backend, sub, events);
}

/** Tell the server first, then drop the browser subscription. A failed server call is not fatal:
 *  the server prunes the dead endpoint on its next push. */
export async function disable(backend: FleetBackend): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  try {
    await backend.pushUnsubscribe({ endpoint: sub.endpoint });
  } catch {
    // see above
  }
  await sub.unsubscribe();
}

export async function updateEvents(backend: FleetBackend, events: PushEvents): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('This device is not subscribed');
  await post(backend, sub, events);
}

export async function sendTest(backend: FleetBackend): Promise<'ok' | 'gone' | 'error'> {
  const sub = await currentSubscription();
  if (!sub) return 'gone';
  const { ok, result } = await backend.pushTest({ endpoint: sub.endpoint });
  return ok ? 'ok' : result;
}

export interface PushStatus {
  /** The browser holds a subscription. */
  browser: boolean;
  /** The server knows it too. */
  subscribed: boolean;
  events: PushEvents;
}

export async function status(backend: FleetBackend): Promise<PushStatus> {
  const sub = await currentSubscription();
  if (!sub) return { browser: false, subscribed: false, events: DEFAULT_PUSH_EVENTS };
  const res = await backend.pushStatus({ endpoint: sub.endpoint });
  return { browser: true, subscribed: res.subscribed, events: res.events ?? DEFAULT_PUSH_EVENTS };
}
