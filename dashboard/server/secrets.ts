// Per-project secrets: ${XDG_CONFIG_HOME:-~/.config}/swarmkit/secrets.json, shape
// { [projectRoot]: { [NAME]: { value, updatedAt } } }. Values go to agent processes as env vars
// (never through the chat) and are scrubbed from everything the dashboard sends to a browser.
// Private (dir 0700, file 0600, no symlinks followed). Everything here is synchronous on
// purpose: the session start paths are synchronous, and with no awaits between a read and its
// write two concurrent PUTs cannot interleave. Never log values or request bodies.
//
// Limits: redaction only covers what passes through this server. Claude's own transcript
// (.jsonl under ~/.claude) and the agent's tool output on disk can still hold a value the
// agent printed; the dashboard just never shows it again.
import {
  closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  chmodSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { configBase } from './auth.ts';
import { ValidationError } from './validate.ts';
import type { ServerEvent, SessionSummary } from '../src/shared/types.ts';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024;
/** Values shorter than this are stored but not redacted (too many false hits). */
export const MIN_REDACT_LENGTH = 6;
/** Hard cap on the store file we are willing to read. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;

const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'ENV', 'BASH_ENV', 'IFS', 'TMPDIR',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
]);
const RESERVED_PREFIXES = [
  'LD_', 'DYLD_', 'SWARMKIT_', 'CLAUDE_', 'ANTHROPIC_', 'FLEET_', 'XDG_', 'OPENCODE_', 'AGY_', 'GIT_',
];

export function isReservedSecretName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some(p => name.startsWith(p));
}

export interface SecretEntry {
  name: string;
  value: string;
}

interface StoredSecret {
  value: string;
  updatedAt: number;
}
type Store = Record<string, Record<string, StoredSecret>>;

/** Directory of the store (not created): $XDG_CONFIG_HOME/swarmkit. */
export function secretsDirPath(): string {
  return path.join(configBase(), 'swarmkit');
}

export function secretsFilePath(): string {
  return path.join(secretsDirPath(), 'secrets.json');
}

// ---------------------------------------------------------------- project scoping

/** Existing absolute directory -> its realpath, or undefined. */
function realDir(cwd: string): string | undefined {
  try {
    const real = realpathSync(cwd);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Nearest ancestor (or self) holding a `.git` entry: the git toplevel, worktrees and submodules included. */
function gitToplevel(dir: string): string | undefined {
  let current = dir;
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Project root for the API: cwd must be an absolute, existing directory. */
export function projectRoot(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new ValidationError('cwd must be an absolute path');
  }
  const real = realDir(cwd);
  if (!real) throw new ValidationError('cwd must be an existing directory');
  return gitToplevel(real) ?? real;
}

/** Same scoping for a session's cwd, which may have vanished: falls back to the plain resolved path. */
function projectRootLoose(cwd: string): string {
  const real = realDir(cwd);
  return real ? (gitToplevel(real) ?? real) : path.resolve(cwd);
}

// ---------------------------------------------------------------- private file store

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('secrets directory is not a plain directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('secrets directory is owned by another user');
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function sanitize(raw: unknown): Store {
  const store: Store = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return store;
  for (const [project, names] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof names !== 'object' || names === null || Array.isArray(names)) continue;
    const entries: Record<string, StoredSecret> = {};
    for (const [name, item] of Object.entries(names as Record<string, unknown>)) {
      const v = item as { value?: unknown; updatedAt?: unknown } | null;
      if (!SECRET_NAME_RE.test(name) || typeof v?.value !== 'string') continue;
      entries[name] = { value: v.value, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 };
    }
    if (Object.keys(entries).length > 0) store[project] = entries;
  }
  return store;
}

let loaded: { file: string; sig: string; store: Store } | undefined;

/** Reads the store (missing file = empty). A file we cannot trust or parse throws; callers never overwrite it blind. */
function loadStore(): Store {
  const file = secretsFilePath();
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      loaded = undefined;
      return {};
    }
    throw new Error('secrets file cannot be opened');
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('secrets file is not a regular file');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('secrets file is owned by another user');
    if (st.size > MAX_STORE_BYTES) throw new Error('secrets file is too large');
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (loaded && loaded.file === file && loaded.sig === sig) return loaded.store;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.subarray(0, off).toString('utf8'));
    } catch {
      throw new Error('secrets file is not valid JSON');
    }
    const store = sanitize(parsed);
    loaded = { file, sig, store };
    return store;
  } finally {
    closeSync(fd);
  }
}

/** Atomic replace: O_EXCL temp file at 0600 (fchmod makes it umask-proof), fsync, rename. */
function saveStore(store: Store): void {
  const dir = secretsDirPath();
  ensurePrivateDir(dir);
  const file = secretsFilePath();
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    const data = Buffer.from(JSON.stringify(store), 'utf8');
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone.
    }
    throw err;
  }
  loaded = undefined;
  invalidateSecretCaches();
  try {
    const dfd = openSync(dir, fsConstants.O_RDONLY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is best effort.
  }
}

// ---------------------------------------------------------------- API operations

export function validSecretName(raw: unknown): string {
  if (typeof raw !== 'string' || !SECRET_NAME_RE.test(raw)) {
    throw new ValidationError('name must be 1-64 characters: A-Z, 0-9 and _, starting with a letter');
  }
  if (isReservedSecretName(raw)) throw new ValidationError('that name is reserved for the environment');
  return raw;
}

export function validSecretValue(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new ValidationError('value must be a non-empty string');
  if (raw.includes('\0')) throw new ValidationError('value must not contain NUL');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_VALUE_BYTES) throw new ValidationError(`value is too large (max ${MAX_SECRET_VALUE_BYTES / 1024} KB)`);
  return raw;
}

/** Names and update times of a project's secrets, never the values. */
export function listSecrets(cwd: unknown): { project: string; names: { name: string; updatedAt: number }[] } {
  const project = projectRoot(cwd);
  const names = Object.entries(loadStore()[project] ?? {})
    .map(([name, s]) => ({ name, updatedAt: s.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { project, names };
}

export function putSecret(cwd: unknown, name: unknown, value: unknown): void {
  const project = projectRoot(cwd);
  const n = validSecretName(name);
  const v = validSecretValue(value);
  const store = structuredClone(loadStore());
  (store[project] ??= {})[n] = { value: v, updatedAt: Date.now() };
  saveStore(store);
}

/** Removing an unknown name is fine (idempotent). */
export function deleteSecret(cwd: unknown, name: unknown): void {
  const project = projectRoot(cwd);
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) throw new ValidationError('name must be a secret name');
  const store = structuredClone(loadStore());
  if (!store[project]?.[name]) return;
  delete store[project][name];
  if (Object.keys(store[project]).length === 0) delete store[project];
  saveStore(store);
}

// ---------------------------------------------------------------- injection

/** A session's project secrets; an unreadable store yields none (the session still starts). */
export function projectSecrets(cwd: string): SecretEntry[] {
  try {
    const own = loadStore()[projectRootLoose(cwd)] ?? {};
    return Object.entries(own).map(([name, s]) => ({ name, value: s.value }));
  } catch (err) {
    console.error('Secrets unavailable:', (err as Error).message);
    return [];
  }
}

/** Env vars of a session's project secrets, to merge over process.env. */
export function secretEnv(cwd: string): Record<string, string> {
  return Object.fromEntries(projectSecrets(cwd).map(s => [s.name, s.value]));
}

/** The one system-prompt line for a project with secrets; undefined without any. */
export function secretsPromptLine(cwd: string): string | undefined {
  const names = projectSecrets(cwd).map(s => s.name).sort();
  if (names.length === 0) return undefined;
  return `Project secrets available as env vars: ${names.join(', ')} (values hidden; never print, echo or log them). If a needed secret is missing, ask the user to add it in the dashboard's Secrets panel; never ask for it in chat.`;
}

// ---------------------------------------------------------------- redaction

interface Matcher {
  regex: RegExp;
  names: Map<string, string>;
}
const matchers = new WeakMap<SecretEntry[], Matcher | null>();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One alternation, longest value first, so a single pass never re-scans a placeholder. */
function matcherFor(entries: SecretEntry[]): Matcher | null {
  const cached = matchers.get(entries);
  if (cached !== undefined) return cached;
  const names = new Map<string, string>();
  for (const e of entries) {
    if (e.value.length < MIN_REDACT_LENGTH) continue;
    names.set(e.value, e.name);
    // Tool inputs travel as JSON text inside strings: match the escaped form too.
    const escaped = JSON.stringify(e.value).slice(1, -1);
    if (escaped !== e.value && escaped.length >= MIN_REDACT_LENGTH && !names.has(escaped)) names.set(escaped, e.name);
  }
  const built: Matcher | null = names.size === 0
    ? null
    : {
        regex: new RegExp([...names.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRegex).join('|'), 'g'),
        names,
      };
  matchers.set(entries, built);
  return built;
}

/** Replaces each secret value (>= 6 chars, longest first) with `[secret:NAME]`. */
export function redactSecrets(text: string, entries: SecretEntry[]): string {
  if (entries.length === 0 || text.length === 0) return text;
  const m = matcherFor(entries);
  if (!m) return text;
  return text.replace(m.regex, hit => `[secret:${m.names.get(hit) ?? 'REDACTED'}]`);
}

/** Deep string walk; arrays and plain objects are copied only where something changed. */
export function redactDeep<T>(value: T, entries: SecretEntry[]): T {
  if (entries.length === 0 || !matcherFor(entries)) return value;
  return walk(value, entries) as T;
}

function walk(value: unknown, entries: SecretEntry[]): unknown {
  if (typeof value === 'string') return redactSecrets(value, entries);
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    value.forEach((item, i) => {
      const next = walk(item, entries);
      if (next !== item) (out ??= value.slice())[i] = next;
    });
    return out ?? value;
  }
  if (typeof value === 'object' && value !== null) {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = walk(item, entries);
      if (next !== item) (out ??= { ...(value as Record<string, unknown>) })[key] = next;
    }
    return out ?? value;
  }
  return value;
}

// Per-cwd value lists for the event path: a short TTL (a new `git init` or an edited file is
// picked up) and a full drop on every PUT/DELETE.
const CACHE_TTL_MS = 5_000;
const CACHE_MAX = 200;
const byCwd = new Map<string, { at: number; entries: SecretEntry[] }>();

export function invalidateSecretCaches(): void {
  byCwd.clear();
}

/** Cached `projectSecrets(cwd)`; a stable array per cwd, empty when the project has none. */
export function secretEntriesForCwd(cwd: string): SecretEntry[] {
  const now = Date.now();
  const hit = byCwd.get(cwd);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.entries;
  if (byCwd.size >= CACHE_MAX) byCwd.clear();
  const entries = projectSecrets(cwd);
  byCwd.set(cwd, { at: now, entries });
  return entries;
}

export interface SecretResolver {
  /** Values for a session id; empty when unknown or without secrets. */
  forSession(sessionId: string): SecretEntry[];
  forCwd(cwd: string): SecretEntry[];
}

export function redactSummary(session: SessionSummary, resolver: SecretResolver): SessionSummary {
  return redactDeep(session, resolver.forCwd(session.cwd));
}

/** Scrubs one ServerEvent with the values of the project it belongs to; returns the same object when nothing changes. */
export function redactServerEvent(event: ServerEvent, resolver: SecretResolver): ServerEvent {
  switch (event.type) {
    case 'hello': {
      const sessions = event.sessions.map(s => redactSummary(s, resolver));
      return sessions.some((s, i) => s !== event.sessions[i]) ? { ...event, sessions } : event;
    }
    case 'session.upsert': {
      const session = redactSummary(event.session, resolver);
      return session === event.session ? event : { ...event, session };
    }
    case 'node.upsert':
      return redactDeep(event, resolver.forSession(event.node.sessionId));
    case 'permission.request':
      return redactDeep(event, resolver.forSession(event.request.sessionId));
    case 'node.event':
    case 'permission.resolved':
      return redactDeep(event, resolver.forSession(event.sessionId));
    default:
      return event;
  }
}
