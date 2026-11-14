// Web Push sender (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292),
// on node:crypto and global fetch only. Pure module: no storage, no event logic (see push.ts).
import type { PushSendResult, PushSubscriptionBody } from '../src/shared/types.ts';
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

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

// One aes128gcm record, capped so the body stays under the 4096-byte record.
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3800;

// base64url alphabet plus up to two trailing '='.
const B64U_RE = /^[A-Za-z0-9_-]*={0,2}$/;

/** Strict base64url decode: accepts missing padding, rejects other characters. */
function b64uDecode(s: string): Buffer {
  if (typeof s !== 'string' || !B64U_RE.test(s)) throw new Error('invalid base64url');
  const body = s.replace(/=+$/, '');
  if (body.length % 4 === 1) throw new Error('invalid base64url');
  return Buffer.from(s, 'base64url');
}

/** base64url encode without padding. */
function b64uEncode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

// HKDF-extract with SHA-256: PRK = HMAC(salt, ikm).
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest();
}

// HKDF-expand with SHA-256, first `len` bytes.
function hkdfExpand(prk: Buffer, info: Buffer, len: number): Buffer {
  const out: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let i = 0;
  while (Buffer.concat(out).length < len) {
    i += 1;
    prev = createHmac('sha256', prk).update(Buffer.concat([prev, info, Buffer.from([i])])).digest();
    out.push(prev);
  }
  return Buffer.concat(out).subarray(0, len);
}

/** True for a mailto: or https: subject URI. */
function isValidSubject(subject: string): boolean {
  if (typeof subject !== 'string') return false;
  if (subject.startsWith('mailto:')) return subject.length > 'mailto:'.length;
  try {
    return new URL(subject).protocol === 'https:';
  } catch {
    return false;
  }
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64uEncode(ecdh.getPublicKey()),
    // getPrivateKey() drops leading zero bytes (about 1 key in 256): pad d to 32 bytes.
    privateKey: b64uEncode(Buffer.concat([Buffer.alloc(32), ecdh.getPrivateKey()]).subarray(-32)),
  };
}

/** https, default port, no credentials, host on a known push service. */
export function isAllowedEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.port !== '') return false;
  if (u.username !== '' || u.password !== '') return false;
  const h = u.hostname;
  if (h === 'fcm.googleapis.com') return true;
  if (h === 'web.push.apple.com') return true;
  if (h === 'updates.push.services.mozilla.com') return true;
  if (h.endsWith('.push.services.mozilla.com')) return true;
  if (h.endsWith('.notify.windows.com')) return true;
  return false;
}

/** Validates an untrusted subscription body; throws Error with a user-facing message. */
export function validatePushTarget(raw: unknown): PushTarget {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid subscription');
  const rec = raw as Record<string, unknown>;
  const endpoint = rec.endpoint;
  const keys = rec.keys;
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2048) {
    throw new Error('invalid endpoint');
  }
  if (!isAllowedEndpoint(endpoint)) throw new Error('invalid endpoint');
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) throw new Error('invalid keys');
  const krec = keys as Record<string, unknown>;
  if (typeof krec.p256dh !== 'string' || typeof krec.auth !== 'string') throw new Error('invalid keys');
  let ua: Buffer;
  let auth: Buffer;
  try {
    ua = b64uDecode(krec.p256dh);
  } catch {
    throw new Error('invalid p256dh');
  }
  try {
    auth = b64uDecode(krec.auth);
  } catch {
    throw new Error('invalid auth');
  }
  if (ua.length !== 65 || ua[0] !== 0x04) throw new Error('invalid p256dh');
  try {
    const check = createECDH('prime256v1');
    check.generateKeys();
    check.computeSecret(ua);
  } catch {
    throw new Error('invalid p256dh');
  }
  if (auth.length !== 16) throw new Error('invalid auth');
  return { endpoint, keys: { p256dh: krec.p256dh, auth: krec.auth } };
}

/** `vapid t=<jwt>, k=<publicKey>` for the endpoint's origin; ES256 in IEEE P1363 (64-byte) form. */
export function vapidAuthHeader(endpoint: string, keys: VapidKeys, subject: string, nowS?: number): string {
  if (!isValidSubject(subject)) throw new Error('invalid subject');
  const t = nowS ?? Math.floor(Date.now() / 1000);
  const aud = new URL(endpoint).origin;
  const head = b64uEncode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(Buffer.from(JSON.stringify({ aud, exp: t + 12 * 3600, sub: subject })));
  const data = `${head}.${body}`;
  const pub = b64uDecode(keys.publicKey);
  const priv = b64uDecode(keys.privateKey);
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) throw new Error('invalid VAPID keys');
  const keyObj = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64uEncode(pub.subarray(1, 33)),
      y: b64uEncode(pub.subarray(33, 65)),
      d: b64uEncode(priv),
    },
    format: 'jwk',
  });
  // ieee-p1363 gives the raw 64-byte r||s the push services require (not DER).
  const sig = sign('sha256', Buffer.from(data), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64uEncode(sig)}, k=${keys.publicKey}`;
}

/** RFC 8291 aes128gcm body (one record). salt / ephemeral private key are injectable for test vectors. */
export function encryptPayload(
  target: PushTarget,
  payload: Uint8Array,
  opts?: { salt?: Uint8Array; ephemeralPrivateKey?: Uint8Array },
): Buffer {
  if (payload.byteLength > MAX_PAYLOAD) throw new Error('payload too large');
  const salt = opts?.salt ? Buffer.from(opts.salt) : randomBytes(16);
  if (salt.length !== 16) throw new Error('invalid salt');
  const uaPublic = b64uDecode(target.keys.p256dh);
  const authSecret = b64uDecode(target.keys.auth);
  const asEcdh = createECDH('prime256v1');
  if (opts?.ephemeralPrivateKey) {
    const raw = Buffer.from(opts.ephemeralPrivateKey);
    if (raw.length !== 32) throw new Error('invalid ephemeral key');
    asEcdh.setPrivateKey(raw);
  } else {
    asEcdh.generateKeys();
  }
  const asPublic = asEcdh.getPublicKey();
  const ecdhSecret = asEcdh.computeSecret(uaPublic);
  // RFC 8291 section 3.4 key schedule.
  const prkKey = hkdfExtract(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = hkdfExpand(prkKey, keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
  // One record: plaintext plus the 0x02 padding delimiter.
  const padded = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const enc = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1 + 65);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = 65;
  asPublic.copy(header, 21);
  return Buffer.concat([header, enc]);
}

/** POST one encrypted push. 'gone' on 404/410 (drop the subscription); never throws. */
export async function sendPush(target: PushTarget, payload: string, keys: VapidKeys, opts: SendOptions): Promise<SendOutcome> {
  if (!isAllowedEndpoint(target.endpoint)) return { result: 'error' };
  try {
    const body = encryptPayload(target, Buffer.from(payload, 'utf8'));
    const auth = vapidAuthHeader(target.endpoint, keys, opts.subject);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(opts.ttl ?? 3600),
        Urgency: opts.urgency ?? 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: auth,
      },
      body: new Uint8Array(body),
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10000),
    });
    const status = res.status;
    await res.body?.cancel().catch(() => {}); // free the connection; the body is not needed
    if (status >= 200 && status < 300) return { result: 'ok', status };
    if (status === 404 || status === 410) return { result: 'gone', status };
    return { result: 'error', status };
  } catch {
    return { result: 'error' };
  }
}
