import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkOrigin, isAuthorized, loadToken, tokenMatches } from '../server/auth.ts';

const TOKEN = 'test-token-abc123';
const HEADER_AUTH = { 'x-fleet-token': TOKEN };

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('loadToken', () => {
  it('creates .data/token with mode 0600 inside a 0700 dir', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fleet-auth-'));
    try {
      const token = loadToken(dir);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(statSync(path.join(dir, '.data', 'token')).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, '.data')).mode & 0o777).toBe(0o700);
      // A second load reuses the stored token instead of rotating it.
      expect(loadToken(dir)).toBe(token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers FLEET_TOKEN and writes nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fleet-auth-'));
    const previous = process.env.FLEET_TOKEN;
    process.env.FLEET_TOKEN = 'env-set-token';
    try {
      expect(loadToken(dir)).toBe('env-set-token');
      expect(() => statSync(path.join(dir, '.data'))).toThrow();
    } finally {
      if (previous === undefined) delete process.env.FLEET_TOKEN;
      else process.env.FLEET_TOKEN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isAuthorized', () => {
  it('accepts the x-fleet-token header', () => {
    expect(isAuthorized(req(HEADER_AUTH), TOKEN)).toBe(true);
  });

  it('accepts the fleet_token cookie', () => {
    expect(isAuthorized(req({ cookie: `other=1; fleet_token=${TOKEN}` }), TOKEN)).toBe(true);
  });

  it('accepts the ?token value via tokenMatches', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('rejects wrong or missing tokens', () => {
    expect(isAuthorized(req({ 'x-fleet-token': 'wrong' }), TOKEN)).toBe(false);
    expect(isAuthorized(req({ cookie: 'fleet_token=wrong' }), TOKEN)).toBe(false);
    expect(isAuthorized(req({}), TOKEN)).toBe(false);
    expect(isAuthorized(req({ 'x-fleet-token': `${TOKEN}x` }), TOKEN)).toBe(false);
  });
});

describe('checkOrigin', () => {
  it('allows absent Origin (curl, tests)', () => {
    expect(checkOrigin(req(HEADER_AUTH))).toBe(true);
  });

  it('allows Origin whose host equals the Host header', () => {
    expect(checkOrigin(req({ origin: 'http://localhost:4317', host: 'localhost:4317' }))).toBe(true);
  });

  it('rejects cross-origin requests', () => {
    expect(checkOrigin(req({ origin: 'http://evil.example', host: 'localhost:4317' }))).toBe(false);
    expect(checkOrigin(req({ origin: 'http://localhost:9999', host: 'localhost:4317' }))).toBe(false);
  });

  it('rejects malformed Origin headers', () => {
    expect(checkOrigin(req({ origin: 'not a url', host: 'localhost:4317' }))).toBe(false);
  });

  it('allows the Host/Origin pair behind tailscale serve (same ts.net host and port)', () => {
    expect(checkOrigin(req({
      origin: 'https://ll-server.tail3e28e1.ts.net:4317',
      host: 'll-server.tail3e28e1.ts.net:4317',
    }))).toBe(true);
  });
});
