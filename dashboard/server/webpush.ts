// Web Push sender (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// on node:crypto and global fetch only. Pure module: no storage, no event logic (see push.ts).
import type { PushSendResult, PushSubscriptionBody } from '../src/shared/types.ts';

/** VAPID keypair, both base64url: publicKey = uncompressed P-256 point (65 bytes), privateKey = d (32 bytes). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** A validated push target: endpoint on an allowlisted push service, p256dh 65-byte point, auth 16 bytes. */
export type PushTarget = PushSubscriptionBody;

export interface SendOptions {
  /** VAPID `sub` claim: a mailto: or https: URI. */
  subject: string;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Seconds the push service keeps an undelivered message (default 3600). */
  ttl?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SendOutcome {
  result: PushSendResult;
  /** HTTP status from the push service, when one came back. */
  status?: number;
}

export function generateVapidKeys(): VapidKeys {
  throw new Error('not implemented');
}

/** https, default port, no credentials, host on a known push service. */
export function isAllowedEndpoint(endpoint: string): boolean {
  void endpoint;
  throw new Error('not implemented');
}

/** Validates an untrusted subscription body; throws Error with a user-facing message. */
export function validatePushTarget(raw: unknown): PushTarget {
  void raw;
  throw new Error('not implemented');
}

/** `vapid t=<jwt>, k=<publicKey>` for the endpoint's origin; ES256 in IEEE P1363 (64-byte) form. */
export function vapidAuthHeader(endpoint: string, keys: VapidKeys, subject: string, nowS?: number): string {
  void endpoint; void keys; void subject; void nowS;
  throw new Error('not implemented');
}

/** RFC 8291 aes128gcm body (one record). salt / ephemeral private key are injectable for test vectors. */
export function encryptPayload(
  target: PushTarget,
  payload: Uint8Array,
  opts?: { salt?: Uint8Array; ephemeralPrivateKey?: Uint8Array },
): Buffer {
  void target; void payload; void opts;
  throw new Error('not implemented');
}

/** POST one encrypted push. 'gone' on 404/410 (drop the subscription); never throws. */
export async function sendPush(target: PushTarget, payload: string, keys: VapidKeys, opts: SendOptions): Promise<SendOutcome> {
  void target; void payload; void keys; void opts;
  throw new Error('not implemented');
}
