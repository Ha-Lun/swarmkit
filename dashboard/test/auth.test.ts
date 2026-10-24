import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allowedHosts,
  checkAuth,
  checkOrigin,
  cookieValueFor,
  createRateLimiter,
  fleetCookie,
  hostAllowed,
  loadToken,
  ownerAllows,
  redirectLocation,
  securityHeaders,
  tokenMatches,
} from '../server/auth.ts';

const TOKEN = 'test-token-abc123';
const DERIVED = cookieValueFor(TOKEN);
const HEADER_AUTH = { 'x-fleet-token': TOKEN };

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function withXdg(dir: string): void {
  process.env.XDG_CONFIG_HOME = dir;
}

/** A temp dashboard dir whose .data we may seed for migration tests. */
function tempHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'fleet-auth-test-'));
}

/** A throwaway $HOME (os.homedir() honours $HOME on Linux) so nothing touches the real ~/.config. */
function fakeHome(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-auth-home-'));
  process.env.HOME = dir;
  return dir;
}

const savedHome = process.env.HOME;
const savedXdg = process.env.XDG_CONFIG_HOME;
const savedTokenEnv = process.env.FLEET_TOKEN;
const savedFleetHosts = process.env.FLEET_HOSTS;

const restoreEnv = (): void => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedTokenEnv === undefined) delete process.env.FLEET_TOKEN;
  else process.env.FLEET_TOKEN = savedTokenEnv;
  if (savedFleetHosts === undefined) delete process.env.FLEET_HOSTS;
  else process.env.FLEET_HOSTS = savedFleetHosts;
};

describe('loadToken', () => {
  it('creates $XDG_CONFIG_HOME/claude-fleet/token (0600) in a 0700 dir', () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'fleet-auth-xdg-'));
    const home = tempHome();
    withXdg(xdg);
    delete process.env.FLEET_TOKEN;
    try {
      const { token, file } = loadToken(home);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(file).toBe(path.join(xdg, 'claude-fleet', 'token'));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(xdg, 'claude-fleet')).mode & 0o777).toBe(0o700);
      // A second load reuses the stored token instead of rotating it.
      expect(loadToken(home)).toEqual({ token, file });
    } finally {
      restoreEnv();
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults to ~/.config/claude-fleet/token without XDG_CONFIG_HOME', () => {
    const home = tempHome();
    const fakeHomeDir = fakeHome();
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.FLEET_TOKEN;
    try {
      const { file, token } = loadToken(home);
      expect(file).toBe(path.join(fakeHomeDir, '.config', 'claude-fleet', 'token'));
      expect(existsSync(file)).toBe(true);
      expect(token.length).toBeGreaterThanOrEqual(32);
    } finally {
      restoreEnv();
      rmSync(fakeHomeDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('migrates a legacy <dataDir>/.data/token value and deletes the old file', () => {
    const xdg = mkdtempSync(path.join(tmpdir(), 'fleet-auth-xdg-'));
    const home = tempHome();
    const legacyDir = path.join(home, '.data');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(path.join(legacyDir, 'token'), 'legacy-secret-token', { mode: 0o600 });
    withXdg(xdg);
    delete process.env.FLEET_TOKEN;
    try {
      const { token, file } = loadToken(home);
      expect(token).toBe('legacy-secret-token');
      expect(readToken(file)).toBe('legacy-secret-token');
      // The old file is gone after the migration.
      expect(existsSync(path.join(legacyDir, 'token'))).toBe(false);
      // A second load does not resurrect the legacy value.
      writeFileSync(path.join(legacyDir, 'token'), 'someone-recreated-it');
      expect(loadToken(home).token).toBe('legacy-secret-token');
    } finally {
      restoreEnv();
      rmSync(xdg, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects FLEET_TOKEN shorter than 32 chars and scrubs it from the env', () => {
    const home = tempHome();
    process.env.FLEET_TOKEN = 'too-short';
    try {
      expect(() => loadToken(home)).toThrow(/at least 32 characters/);
      expect(process.env.FLEET_TOKEN).toBeUndefined();
    } finally {
      restoreEnv();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('accepts FLEET_TOKEN of >= 32 chars, deletes it from the env and writes no file', () => {
    const home = tempHome();
    const fakeHomeDir = fakeHome();
    const envToken = 'x'.repeat(32);
    process.env.FLEET_TOKEN = envToken;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const { token, file } = loadToken(home);
      expect(token).toBe(envToken);
      expect(file).toBe('');
      expect(process.env.FLEET_TOKEN).toBeUndefined();
      // Nothing was persisted that a later start could pick up.
      expect(existsSync(tokenFileOf())).toBe(false);
    } finally {
      restoreEnv();
      rmSync(fakeHomeDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function tokenFileOf(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg || path.join(homedir(), '.config'), 'claude-fleet', 'token');
}

function readToken(file: string): string {
  return readFileSync(file, 'utf8').trim();
}

describe('checkAuth', () => {
  it('accepts the x-fleet-token header (raw token)', () => {
    expect(checkAuth(req(HEADER_AUTH), TOKEN)).toBe('header');
  });

  it('accepts the fleet_token cookie only when it carries the derived HMAC value', () => {
    expect(checkAuth(req({ cookie: `other=1; fleet_token=${DERIVED}` }), TOKEN)).toBe('cookie');
    expect(checkAuth(req({ cookie: `fleet_token=${DERIVED}` }), TOKEN)).toBe('cookie');
    // The raw token inside the cookie is rejected: only the derived value is accepted there.
    expect(checkAuth(req({ cookie: `fleet_token=${TOKEN}` }), TOKEN)).toBe(null);
    expect(checkAuth(req({ cookie: `fleet_token=${TOKEN}` }), TOKEN)).toBe(null);
  });

  it('accepts the ?token value via tokenMatches (raw token, never the derived one)', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(DERIVED, TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('rejects wrong or missing tokens', () => {
    expect(checkAuth(req({ 'x-fleet-token': 'wrong' }), TOKEN)).toBe(null);
    expect(checkAuth(req({ cookie: 'fleet_token=wrong' }), TOKEN)).toBe(null);
    expect(checkAuth(req({}), TOKEN)).toBe(null);
    expect(checkAuth(req({ 'x-fleet-token': `${TOKEN}x` }), TOKEN)).toBe(null);
  });
});

describe('checkOrigin', () => {
  it('allows a missing Origin only when auth came from the header', () => {
    expect(checkOrigin(req(HEADER_AUTH), 'header')).toBe(true);
    expect(checkOrigin(req({ cookie: `fleet_token=${DERIVED}` }), 'cookie')).toBe(false);
  });

  it('allows matching origins regardless of how the request authenticated', () => {
    expect(checkOrigin(req({ origin: 'http://localhost:4317', host: 'localhost:4317' }), 'cookie')).toBe(true);
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

describe('ownerAllows', () => {
  it('is permissive when FLEET_OWNER is unset', () => {
    expect(ownerAllows('anyone@ts.net', undefined)).toBe(true);
  });

  it('allows requests without the tailscale-user-login header (local access)', () => {
    expect(ownerAllows(undefined, 'me@ts.net')).toBe(true);
    expect(ownerAllows(['header'], 'me@ts.net')).toBe(true); // non-string header value
  });

  it('rejects a differing header and accepts the owner', () => {
    expect(ownerAllows('other@ts.net', 'me@ts.net')).toBe(false);
    expect(ownerAllows('me@ts.net', 'me@ts.net')).toBe(true);
  });
});

describe('createRateLimiter', () => {
  it('allows the limit and rejects the next attempt within the window', () => {
    let now = 0;
    const limiter = createRateLimiter(3, 60_000, () => now);
    expect(limiter('a')).toBe(true);
    expect(limiter('a')).toBe(true);
    expect(limiter('a')).toBe(true);
    expect(limiter('a')).toBe(false);
    expect(limiter('b')).toBe(true); // per key
  });

  it('resets after the window', () => {
    let now = 0;
    const limiter = createRateLimiter(1, 60_000, () => now);
    expect(limiter('a')).toBe(true);
    expect(limiter('a')).toBe(false);
    now = 60_000;
    expect(limiter('a')).toBe(true);
  });
});

describe('host allowlist', () => {
  it('builds the default list from the port', () => {
    delete process.env.FLEET_HOSTS;
    expect(allowedHosts(4317)).toEqual([
      '127.0.0.1:4317',
      'localhost:4317',
      'll-server.tail3e28e1.ts.net:4317',
    ]);
  });

  it('honours a FLEET_HOSTS override', () => {
    process.env.FLEET_HOSTS = '127.0.0.1:4317, myhost.ts.net:4317 ';
    try {
      expect(allowedHosts(4317)).toEqual(['127.0.0.1:4317', 'myhost.ts.net:4317']);
    } finally {
      restoreEnv();
    }
  });

  it('matches case-insensitively and rejects unknown or missing hosts', () => {
    const list = allowedHosts(4317);
    expect(hostAllowed('LocalHost:4317', list)).toBe(true);
    expect(hostAllowed('ll-server.tail3e28e1.ts.net:4317', list)).toBe(true);
    expect(hostAllowed('evil.example:4317', list)).toBe(false);
    expect(hostAllowed('127.0.0.1:9999', list)).toBe(false);
    expect(hostAllowed(undefined, list)).toBe(false);
  });
});

describe('securityHeaders', () => {
  it('sends the frame/sniff/referrer headers on every response', () => {
    for (const dev of [true, false]) {
      const headers = securityHeaders(dev);
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Referrer-Policy']).toBe('no-referrer');
    }
  });

  it('omits the CSP in development (Vite injects inline scripts) and sends it in production', () => {
    expect(securityHeaders(true)['Content-Security-Policy']).toBeUndefined();
    const csp = securityHeaders(false)['Content-Security-Policy']!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});

describe('redirectLocation', () => {
  it('keeps the path (same shape) plus the remaining query, without the token', () => {
    expect(redirectLocation('/', '')).toBe('/');
    expect(redirectLocation('/', 'x=1')).toBe('/?x=1');
    expect(redirectLocation('/foo/bar', '')).toBe('/foo/bar');
    expect(redirectLocation('/foo/bar', 'kept=1&more=2')).toBe('/foo/bar?kept=1&more=2');
    expect(redirectLocation('/deep//nested/', '')).toBe('/deep//nested/'); // spec strips only the LEADING slashes
  });
});

describe('fleetCookie', () => {
  it('marks the cookie HttpOnly, SameSite=Strict and optionally Secure', () => {
    expect(fleetCookie(DERIVED, false)).toBe(`fleet_token=${DERIVED}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    expect(fleetCookie(DERIVED, true)).toBe(`fleet_token=${DERIVED}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`);
  });
});
