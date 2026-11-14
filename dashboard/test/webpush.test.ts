// Web Push sender: RFC 8291 vector, VAPID header, endpoint checks, sendPush, round trip.
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPayload,
  generateVapidKeys,
  isAllowedEndpoint,
  sendPush,
  validatePushTarget,
  vapidAuthHeader,
} from '../server/webpush.ts';

const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

function b64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function validTarget(endpoint = 'https://fcm.googleapis.com/fcm/send/x') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

describe('encryptPayload RFC 8291 Appendix A', () => {
  it('matches the test vector byte for byte (with opts)', () => {
    const target = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
    };
    const out = encryptPayload(target, Buffer.from(RFC.plaintext, 'utf8'), {
      salt: b64u(RFC.salt),
      ephemeralPrivateKey: b64u(RFC.asPrivate),
    });
    const expected = Buffer.concat([b64u(RFC.header), b64u(RFC.ciphertext)]);
    expect(out.equals(expected)).toBe(true);
    expect(out).toEqual(expected);
  });

  it('rejects a payload over 3800 bytes', () => {
    const target = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: RFC.uaPublic, auth: RFC.auth },
    };
    expect(() => encryptPayload(target, Buffer.alloc(3801))).toThrow();
  });
});

describe('vapidAuthHeader', () => {
  it('signs a verifiable 64-byte JWT with aud and exp', () => {
    const keys = generateVapidKeys();
    expect(b64u(keys.publicKey).length).toBe(65);
    expect(b64u(keys.privateKey).length).toBe(32);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    const nowS = 1700000000;
    const h = vapidAuthHeader(endpoint, keys, 'mailto:admin@example.com', nowS);
    expect(h.startsWith('vapid t=')).toBe(true);
    expect(h).toContain(`, k=${keys.publicKey}`);
    const jwt = h.slice('vapid t='.length, h.indexOf(', k='));
    const [eh, ep, es] = jwt.split('.');
    const header = JSON.parse(Buffer.from(eh!, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(ep!, 'base64url').toString('utf8'));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.exp).toBe(nowS + 43200);
    expect(claims.sub).toBe('mailto:admin@example.com');
    const sig = b64u(es!);
    expect(sig.length).toBe(64);
    const pub = b64u(keys.publicKey);
    const pubKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${eh}.${ep}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });

  it('accepts an https subject and rejects a bare string', () => {
    const keys = generateVapidKeys();
    const endpoint = 'https://fcm.googleapis.com/x';
    expect(() => vapidAuthHeader(endpoint, keys, 'https://example.com/app')).not.toThrow();
    expect(() => vapidAuthHeader(endpoint, keys, 'bare-string')).toThrow();
    expect(() => vapidAuthHeader(endpoint, keys, 'http://example.com/x')).toThrow();
  });
});

describe('isAllowedEndpoint / validatePushTarget', () => {
  it('accepts the four push services', () => {
    expect(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isAllowedEndpoint('https://web.push.apple.com/push/x')).toBe(true);
    expect(isAllowedEndpoint('https://updates.push.services.mozilla.com/push/x')).toBe(true);
    expect(isAllowedEndpoint('https://foo.push.services.mozilla.com/push/x')).toBe(true);
    expect(isAllowedEndpoint('https://foo.notify.windows.com/push/x')).toBe(true);
  });

  it('rejects http, ports, credentials, lookalikes and localhost', () => {
    expect(isAllowedEndpoint('http://fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isAllowedEndpoint('https://fcm.googleapis.com:8443/fcm/send/x')).toBe(false);
    expect(isAllowedEndpoint('https://user:pass@fcm.googleapis.com/fcm/send/x')).toBe(false);
    expect(isAllowedEndpoint('https://evilpush.services.mozilla.com/push/x')).toBe(false);
    expect(isAllowedEndpoint('https://fcm.googleapis.com.evil.com/fcm/send/x')).toBe(false);
    expect(isAllowedEndpoint('https://localhost/push/x')).toBe(false);
    expect(isAllowedEndpoint('not a url')).toBe(false);
  });

  it('validates a good subscription and drops other fields', () => {
    const raw = { ...validTarget(), extra: 'drop me', keys: { ...validTarget().keys } };
    const t = validatePushTarget({ endpoint: raw.endpoint, keys: raw.keys, extra: 1 });
    expect(t).toEqual({ endpoint: raw.endpoint, keys: raw.keys });
    expect('extra' in t).toBe(false);
  });

  it('rejects bad bodies, keys and endpoints', () => {
    const good = validTarget();
    expect(() => validatePushTarget(null)).toThrow();
    expect(() => validatePushTarget('x')).toThrow();
    expect(() => validatePushTarget([])).toThrow();
    // 64-byte p256dh.
    expect(() =>
      validatePushTarget({
        endpoint: good.endpoint,
        keys: { p256dh: randomBytes(64).toString('base64url'), auth: good.keys.auth },
      }),
    ).toThrow();
    // 65-byte point off the curve (0x04 followed by zeros).
    const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64)]).toString('base64url');
    expect(() =>
      validatePushTarget({ endpoint: good.endpoint, keys: { p256dh: offCurve, auth: good.keys.auth } }),
    ).toThrow();
    // 15-byte auth.
    expect(() =>
      validatePushTarget({
        endpoint: good.endpoint,
        keys: { p256dh: good.keys.p256dh, auth: randomBytes(15).toString('base64url') },
      }),
    ).toThrow();
    // Bad characters in p256dh.
    expect(() =>
      validatePushTarget({
        endpoint: good.endpoint,
        keys: { p256dh: '***not-base64***', auth: good.keys.auth },
      }),
    ).toThrow();
    // Disallowed endpoint.
    expect(() =>
      validatePushTarget({ endpoint: 'https://localhost/push/x', keys: good.keys }),
    ).toThrow();
    // Too-long endpoint.
    expect(() =>
      validatePushTarget({ endpoint: `https://fcm.googleapis.com/${'x'.repeat(2048)}`, keys: good.keys }),
    ).toThrow();
  });

  it('accepts unpadded base64url', () => {
    const good = validTarget();
    const strip = (s: string) => s.replace(/=+$/, '');
    const t = validatePushTarget({
      endpoint: good.endpoint,
      keys: { p256dh: strip(good.keys.p256dh), auth: strip(good.keys.auth) },
    });
    expect(t.endpoint).toBe(good.endpoint);
  });
});

describe('sendPush', () => {
  const keys = () => generateVapidKeys();

  function fakeFetch(status: number, capture: { url?: string; init?: Record<string, unknown> }) {
    return (async (url: unknown, init: unknown) => {
      capture.url = url as string;
      capture.init = init as Record<string, unknown>;
      return { status, ok: status >= 200 && status < 300 } as Response;
    }) as typeof fetch;
  }

  it('201 -> ok with the five headers and redirect error', async () => {
    const capture: { url?: string; init?: Record<string, unknown> } = {};
    const out = await sendPush(validTarget(), '{"title":"hi"}', keys(), {
      subject: 'mailto:a@example.com',
      fetchImpl: fakeFetch(201, capture),
    });
    expect(out).toEqual({ result: 'ok', status: 201 });
    const init = capture.init as { headers: Record<string, string>; redirect: string; method: string };
    expect(capture.url).toBe('https://fcm.googleapis.com/fcm/send/x');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers['TTL']).toBe('3600');
    expect(init.headers['Urgency']).toBe('normal');
    expect(init.headers['Content-Encoding']).toBe('aes128gcm');
    expect(init.headers['Content-Type']).toBe('application/octet-stream');
    expect(init.headers['Authorization'].startsWith('vapid t=')).toBe(true);
  });

  it('410 and 404 -> gone; 500 -> error with status; throw -> error', async () => {
    const k = keys();
    const t = validTarget();
    const opts = (fetchImpl: typeof fetch) => ({ subject: 'mailto:a@example.com', fetchImpl });
    expect(await sendPush(t, 'x', k, opts(fakeFetch(410, {})))).toEqual({ result: 'gone', status: 410 });
    expect(await sendPush(t, 'x', k, opts(fakeFetch(404, {})))).toEqual({ result: 'gone', status: 404 });
    expect(await sendPush(t, 'x', k, opts(fakeFetch(500, {})))).toEqual({ result: 'error', status: 500 });
    const throwing = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await sendPush(t, 'x', k, opts(throwing))).toEqual({ result: 'error' });
  });

  it('never calls fetch for a disallowed endpoint', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return { status: 201, ok: true } as Response;
    }) as typeof fetch;
    const t = { ...validTarget(), endpoint: 'https://localhost/push/x' };
    expect(await sendPush(t, 'x', keys(), { subject: 'mailto:a@example.com', fetchImpl })).toEqual({
      result: 'error',
    });
    expect(called).toBe(false);
  });
});

describe('encrypt round trip', () => {
  it('decrypts with the UA private key', () => {
    // Receiver side: fresh UA keypair and auth secret.
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const uaPublic = ua.getPublicKey();
    const authSecret = randomBytes(16);
    const target = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/x',
      keys: { p256dh: uaPublic.toString('base64url'), auth: authSecret.toString('base64url') },
    };
    const plaintext = Buffer.from('hello push 🌊', 'utf8');
    const out = encryptPayload(target, plaintext);
    // Sender header.
    const salt = out.subarray(0, 16);
    const asPublic = out.subarray(21, 86);
    const body = out.subarray(86);
    // Receiver derives the same keys from its private key.
    const secret = ua.computeSecret(asPublic);
    const extract = (s: Buffer, i: Buffer) => createHmac('sha256', s).update(i).digest();
    const expand = (prk: Buffer, info: Buffer, len: number) => {
      const t = createHmac('sha256', prk)
        .update(Buffer.concat([info, Buffer.from([0x01])]))
        .digest();
      return t.subarray(0, len);
    };
    const prkKey = extract(authSecret, secret);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
    const ikm = expand(prkKey, keyInfo, 32);
    const prk = extract(salt, ikm);
    const cek = expand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
    const nonce = expand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    const enc = body.subarray(0, body.length - 16);
    decipher.setAuthTag(body.subarray(body.length - 16));
    const padded = Buffer.concat([decipher.update(enc), decipher.final()]);
    expect(padded.subarray(padded.length - 1)).toEqual(Buffer.from([0x02]));
    expect(Buffer.from(padded.subarray(0, padded.length - 1)).toString('utf8')).toBe('hello push 🌊');
  });
});
