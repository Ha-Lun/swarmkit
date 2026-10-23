// Token check, CSRF guard and cookie auth for the dashboard server.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';

/** Reads the shared token from FLEET_TOKEN, <dataDir>/.data/token, or creates it (dir 0700, file 0600). */
export function loadToken(dataDir: string): string {
  const fromEnv = process.env.FLEET_TOKEN;
  if (fromEnv) return fromEnv;
  const dir = path.join(dataDir, '.data');
  const file = path.join(dir, 'token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through to creation
  }
  const token = randomBytes(24).toString('base64url');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.error('Could not persist the dashboard token:', err);
  }
  return token;
}

/** Length-checked timing-safe token comparison; both values are treated as UTF-8. */
export function tokenMatches(provided: string | undefined, token: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token sent as header `x-fleet-token`, query token or cookie `fleet_token`. */
function providedToken(req: IncomingMessage): string | undefined {
  const header = req.headers['x-fleet-token'];
  if (typeof header === 'string' && header) return header;
  return cookieToken(req);
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

/** True when the request carries the valid token (header or cookie). */
export function isAuthorized(req: IncomingMessage, token: string): boolean {
  return tokenMatches(providedToken(req), token);
}

/**
 * CSRF guard for state-changing requests (POST/DELETE): the Origin header must
 * be absent (curl, tests) or its host must equal the request's Host header.
 */
export function checkOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
