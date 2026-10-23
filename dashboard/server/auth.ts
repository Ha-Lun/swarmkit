// Token storage (XDG config), auth checks (header token, derived cookie), CSRF/Origin
// guard, owner check, host allowlist, security headers and other small pure HTTP helpers.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

export interface TokenResult {
  token: string;
  /** File the token is stored in; '' when it came from FLEET_TOKEN. */
  file: string;
}

/** Token file location: $XDG_CONFIG_HOME/claude-fleet/token, default ~/.config/claude-fleet/token. */
export function tokenFilePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
  return path.join(base, 'claude-fleet', 'token');
}

/**
 * Loads the fleet token from FLEET_TOKEN (must be >= 32 chars; removed from the
 * environment after reading), the XDG token file, or the legacy <dataDir>/.data/token
 * (its value is migrated to the XDG file and the old file deleted), creating a fresh
 * token otherwise (dir 0700, file 0600).
 */
export function loadToken(dataDir: string): TokenResult {
  const fromEnv = process.env.FLEET_TOKEN;
  if (fromEnv) {
    delete process.env.FLEET_TOKEN;
    if (fromEnv.length < 32) {
      throw new Error(`FLEET_TOKEN must be at least 32 characters (got ${fromEnv.length})`);
    }
    return { token: fromEnv, file: '' };
  }
  const file = tokenFilePath();
  let token = readTokenIfPresent(file);
  if (!token) {
    const legacyFile = path.join(dataDir, '.data', 'token');
    const legacy = readTokenIfPresent(legacyFile);
    if (legacy) {
      try {
        writeTokenFile(file, legacy);
        rmSync(legacyFile);
        token = legacy;
      } catch (err) {
        console.error('Could not migrate the legacy dashboard token:', err);
      }
    }
  }
  if (!token) {
    token = randomBytes(32).toString('base64url');
    try {
      writeTokenFile(file, token);
    } catch (err) {
      console.error('Could not persist the dashboard token:', err);
    }
  }
  return { token, file };
}

function readTokenIfPresent(file: string): string | undefined {
  try {
    const value = readFileSync(file, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function writeTokenFile(file: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
}

/** HMAC-SHA256(token, 'fleet-cookie-v1') in base64url: the only value accepted in the fleet_token cookie. */
export function cookieValueFor(token: string): string {
  return createHmac('sha256', token).update('fleet-cookie-v1').digest('base64url');
}

/** Length-checked timing-safe token comparison; both values are treated as UTF-8. */
export function tokenMatches(provided: string | undefined, token: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== 'fleet_token') continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * How the request authenticated: 'header' (x-fleet-token with the raw token),
 * 'cookie' (fleet_token with the derived HMAC value), or null. The raw token is
 * never accepted as a cookie value and the derived value is never accepted as a
 * header or ?token= value.
 */
export function checkAuth(req: IncomingMessage, token: string): 'header' | 'cookie' | null {
  const header = req.headers['x-fleet-token'];
  if (typeof header === 'string' && tokenMatches(header, token)) return 'header';
  const cookie = cookieToken(req);
  if (cookie && tokenMatches(cookie, cookieValueFor(token))) return 'cookie';
  return null;
}

/**
 * CSRF guard for state-changing requests (POST/DELETE). A request without an
 * Origin header (curl, tests) is accepted only when it authenticated with the
 * x-fleet-token header — not with the cookie. With an Origin present, its host
 * must equal the request's Host header.
 */
export function checkOrigin(req: IncomingMessage, via: 'header' | 'cookie' | null = 'header'): boolean {
  const origin = req.headers.origin;
  if (!origin) return via === 'header';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** When FLEET_OWNER is set, a present tailscale-user-login header must match it; absent header (local access) is allowed. */
export function ownerAllows(login: string | string[] | undefined, owner: string | undefined): boolean {
  if (!owner) return true;
  if (typeof login !== 'string' || login.length === 0) return true;
  return tokenMatches(login, owner);
}

/** Fixed-window rate limiter: `limit` attempts per key per window (POST /api/auth). */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): (key: string) => boolean {
  const entries = new Map<string, { first: number; count: number }>();
  return key => {
    const current = now();
    const entry = entries.get(key);
    if (!entry || current - entry.first >= windowMs) {
      if (entries.size > 4096) {
        for (const [k, v] of entries) {
          if (current - v.first >= windowMs) entries.delete(k);
        }
      }
      entries.set(key, { first: current, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

/** Host allowlist: FLEET_HOSTS (comma separated host:port) or the default list for a port. */
export function allowedHosts(port: number, fleetHosts = process.env.FLEET_HOSTS): string[] {
  if (fleetHosts && fleetHosts.trim()) {
    return fleetHosts.split(',').map(h => h.trim()).filter(Boolean);
  }
  return [`127.0.0.1:${port}`, `localhost:${port}`, `ll-server.tail3e28e1.ts.net:${port}`];
}

export function hostAllowed(host: string | string[] | undefined, list: string[]): boolean {
  const value = typeof host === 'string' ? host : undefined;
  if (!value) return false;
  return list.some(h => h.toLowerCase() === value.toLowerCase());
}

/**
 * Security headers set on every response. The Content-Security-Policy is omitted in
 * development (Vite injects inline scripts); everything else applies always.
 */
export function securityHeaders(development: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  if (!development) {
    headers['Content-Security-Policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
  }
  return headers;
}

/** Location of the post-token redirect: the request path (+ remaining query), never query-string-absolute. */
export function redirectLocation(pathname: string, query: string): string {
  const target = '/' + pathname.replace(/^\/+/, '');
  return target + (query ? `?${query}` : '');
}

/** The fleet_token Set-Cookie header value; `value` must be the derived cookie value, not the raw token. */
export function fleetCookie(value: string, secure: boolean): string {
  return `fleet_token=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`;
}
