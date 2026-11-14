import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, deviceLabel, parseDeepLink, sameKey, stripDeepLink } from '../src/client/push.ts';

describe('base64UrlToBytes', () => {
  it('decodes the url-safe alphabet without padding', () => {
    // 0xfb 0xff 0xfe is "+//+" in base64, "-__-" in base64url
    expect([...base64UrlToBytes('-__-')]).toEqual([0xfb, 0xff, 0xfe]);
    expect([...base64UrlToBytes('aGk')]).toEqual([0x68, 0x69]);
    expect([...base64UrlToBytes('aA')]).toEqual([0x68]);
  });

  it('decodes a 65-byte VAPID key to 65 bytes', () => {
    const raw = Uint8Array.from({ length: 65 }, (_, i) => (i * 7 + 4) % 256);
    const b64url = Buffer.from(raw).toString('base64url');
    expect(b64url.length).toBe(87);
    expect([...base64UrlToBytes(b64url)]).toEqual([...raw]);
  });
});

describe('sameKey', () => {
  it('compares an existing subscription key with the server key', () => {
    const key = Uint8Array.from([4, 1, 2, 3]);
    expect(sameKey(Uint8Array.from([4, 1, 2, 3]).buffer, key)).toBe(true);
    expect(sameKey(Uint8Array.from([4, 1, 2, 9]).buffer, key)).toBe(false);
    expect(sameKey(Uint8Array.from([4, 1, 2]).buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
  });
});

describe('deviceLabel', () => {
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

  it('names the OS family and browser', () => {
    expect(deviceLabel(android)).toBe('Android Chrome');
    expect(deviceLabel(desktop)).toBe('Desktop Chrome');
    expect(deviceLabel(desktop + ' Edg/141.0.0.0')).toBe('Desktop Edge');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('Desktop Firefox');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iOS Safari');
  });

  it('falls back and stays within 60 characters', () => {
    expect(deviceLabel('')).toBe('Desktop Browser');
    expect(deviceLabel('x'.repeat(500)).length).toBeLessThanOrEqual(60);
  });
});

describe('parseDeepLink', () => {
  it('reads a session id or the workers flag', () => {
    expect(parseDeepLink('/?session=abc-123')).toEqual({ session: 'abc-123' });
    expect(parseDeepLink('?session=a%20b')).toEqual({ session: 'a b' });
    expect(parseDeepLink('/?workers=1')).toEqual({ workers: true });
    expect(parseDeepLink('https://host.ts.net/?workers=1&x=2')).toEqual({ workers: true });
  });

  it('returns null for the plain dashboard and non-links', () => {
    expect(parseDeepLink('/')).toBeNull();
    expect(parseDeepLink('/?workers=0')).toBeNull();
    expect(parseDeepLink('/?session=')).toBeNull();
  });
});

describe('stripDeepLink', () => {
  it('removes only the deep-link params', () => {
    expect(stripDeepLink('?session=abc')).toBe('');
    expect(stripDeepLink('?workers=1&mock=1')).toBe('?mock=1');
    expect(stripDeepLink('')).toBe('');
  });
});
