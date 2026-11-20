// Per-project secrets: ${XDG_CONFIG_HOME:-~/.config}/swarmkit/secrets.json, shape
// { [projectRoot]: { [NAME]: { value, updatedAt } }, "__retired__"?: [{ value, name, retiredAt }] }.
// "__retired__" can never be a project root (those are absolute paths), and an older build skips it
// as a non-object entry, so the file stays readable both ways. Values go to agent processes as env vars
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
import { homeRealSync, isInside } from './paths.ts';
import { ValidationError } from './validate.ts';
import type { ServerEvent } from '../src/shared/types.ts';

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024;
/** Values shorter than this are stored but not redacted (too many false hits). */
export const MIN_REDACT_LENGTH = 6;
/**
 * Values with fewer distinct characters ("aaaaaa", "000000") are stored but not redacted: they are
 * not real secrets, they would mangle ordinary text, and long runs of them make the alternation slow.
 */
export const MIN_REDACT_DISTINCT_CHARS = 4;
/** Per project: how many secrets, and the total value bytes (all of them land in one env block, so E2BIG is the limit). */
export const MAX_SECRETS_PER_PROJECT = 64;
export const MAX_PROJECT_SECRET_BYTES = 128 * 1024;
/** Serialized size of the projects section at which a PUT is refused. Retired values have their own budget below. */
export const MAX_STORE_WRITE_BYTES = 1024 * 1024;
/**
 * Deleted or replaced values stay in the store (redaction only, never injected or listed) so a
 * restart does not make an old transcript show them again. Own budget, separate from the 1 MB for
 * live secrets: at most this many entries and this many serialized bytes, oldest dropped first.
 */
export const MAX_RETIRED_ENTRIES = 256;
export const MAX_RETIRED_BYTES = 1024 * 1024;
/** Values this process handed to agents that stay in memory for redaction (least recently injected dropped first). */
export const MAX_INJECTED_VALUES = 512;
const RETIRED_KEY = '__retired__';
/** Hard cap on the store file we are willing to read. */
const MAX_STORE_BYTES = 8 * 1024 * 1024;

// Names that change how a program, shell, loader or network client behaves: a secret under one of
// them would be a way to hijack the agent's tools instead of handing it a credential.
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'PWD', 'SHELL', 'USER', 'ENV', 'BASH_ENV', 'IFS', 'TMPDIR',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP',
  'SHELLOPTS', 'PS1', 'PS2', 'PS3', 'PS4', 'PROMPT_COMMAND', 'CDPATH', 'GLOBIGNORE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'LESSOPEN', 'LESSCLOSE', 'BROWSER', 'GNUPGHOME',
  'LOCPATH', 'NLSPATH', 'HOSTALIASES', 'TERM', 'LANG', 'LANGUAGE', 'TZ',
]);
const RESERVED_PREFIXES = [
  'LD_', 'DYLD_', 'SWARMKIT_', 'CLAUDE_', 'ANTHROPIC_', 'FLEET_', 'XDG_', 'OPENCODE_', 'AGY_', 'GIT_',
  'NODE_', 'NPM_CONFIG_', 'PYTHON', 'PERL', 'RUBY', 'BASH', 'GLIBC_', 'MALLOC_', 'OPENSSL_', 'SSL_', 'SSH_',
  'LC_', 'JAVA_', 'JDK_', 'GCONV_',
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
interface RetiredSecret {
  value: string;
  name: string;
  retiredAt: number;
}
interface Store {
  projects: Record<string, Record<string, StoredSecret>>;
  /** Oldest first. */
  retired: RetiredSecret[];
}

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

/**
 * Nearest ancestor (or self) holding a `.git` entry: the git toplevel, worktrees and submodules
 * included. The walk stops before $HOME: a dotfiles repo there must not become the scope of every
 * folder below it.
 */
function gitToplevel(dir: string, home: string): string | undefined {
  let current = dir;
  while (current !== home) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** A folder inside $HOME scopes to its git toplevel (never $HOME itself); anything else to itself. */
function scopeOf(real: string, home: string): string {
  return isInside(home, real) ? (gitToplevel(real, home) ?? real) : real;
}

/** Project root for the API: cwd must be an absolute, existing directory inside $HOME (same contract as starting a session). */
export function projectRoot(cwd: unknown): string {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
    throw new ValidationError('cwd must be an absolute path');
  }
  const real = realDir(cwd);
  if (!real) throw new ValidationError('cwd must be an existing directory');
  const home = homeRealSync();
  if (!isInside(home, real)) throw new ValidationError('cwd must be inside your home directory');
  return scopeOf(real, home);
}

/** Same scoping for a session's cwd, which may have vanished: falls back to the plain resolved path. */
function projectRootLoose(cwd: string): string {
  const real = realDir(cwd);
  return real ? scopeOf(real, homeRealSync()) : path.resolve(cwd);
}

// ---------------------------------------------------------------- private file store

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('secrets directory is not a plain directory');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('secrets directory is owned by another user');
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function retiredBytes(entry: RetiredSecret): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8');
}

/** Newest-first walk under both caps: what survives is the most recent run of entries that fits. */
function capRetired(list: RetiredSecret[]): RetiredSecret[] {
  let bytes = 0;
  let keep = 0;
  for (let i = list.length - 1; i >= 0 && keep < MAX_RETIRED_ENTRIES; i--) {
    bytes += retiredBytes(list[i]!);
    if (bytes > MAX_RETIRED_BYTES) break;
    keep++;
  }
  return keep === list.length ? list : list.slice(list.length - keep);
}

function sanitize(raw: unknown): Store {
  const store: Store = { projects: {}, retired: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return store;
  for (const [project, names] of Object.entries(raw as Record<string, unknown>)) {
    if (project === RETIRED_KEY) {
      if (!Array.isArray(names)) continue;
      const list: RetiredSecret[] = [];
      for (const item of names) {
        const v = item as { value?: unknown; name?: unknown; retiredAt?: unknown } | null;
        if (typeof v?.value !== 'string' || v.value.length === 0) continue;
        list.push({
          value: v.value,
          name: typeof v.name === 'string' && SECRET_NAME_RE.test(v.name) ? v.name : 'REDACTED',
          retiredAt: typeof v.retiredAt === 'number' ? v.retiredAt : 0,
        });
      }
      store.retired = capRetired(list);
      continue;
    }
    if (typeof names !== 'object' || names === null || Array.isArray(names)) continue;
    const entries: Record<string, StoredSecret> = {};
    for (const [name, item] of Object.entries(names as Record<string, unknown>)) {
      const v = item as { value?: unknown; updatedAt?: unknown } | null;
      if (!SECRET_NAME_RE.test(name) || typeof v?.value !== 'string') continue;
      entries[name] = { value: v.value, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0 };
    }
    if (Object.keys(entries).length > 0) store.projects[project] = entries;
  }
  return store;
}

let loaded: { file: string; sig: string; store: Store } | undefined;
const EMPTY_STORE: Store = Object.freeze({ projects: Object.freeze({}), retired: Object.freeze([]) }) as unknown as Store;
/** The last store that loaded or saved cleanly: redaction falls back to it when a reload fails. */
let lastGood: Store = EMPTY_STORE;
/** How long redaction reuses its last store before it looks at the secrets file again. */
const REDACTION_RECHECK_MS = 1000;
/** The store redaction last used, the file it came from and when it was checked (stamped on failures too). */
let redactionCache: { file: string; at: number; store: Store } | undefined;

/** Reads the store (missing file = empty). A file we cannot trust or parse throws; callers never overwrite it blind. */
function loadStore(): Store {
  const file = secretsFilePath();
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      loaded = undefined;
      lastGood = EMPTY_STORE;
      return EMPTY_STORE;
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
    if (loaded && loaded.file === file && loaded.sig === sig) {
      lastGood = loaded.store;
      return loaded.store;
    }
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
    lastGood = store;
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
    const data = Buffer.from(JSON.stringify(store.retired.length > 0 ? { ...store.projects, [RETIRED_KEY]: store.retired } : store.projects), 'utf8');
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
  lastGood = store;
  redactionCache = undefined;
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
  if (isReservedSecretName(raw)) {
    throw new ValidationError('that name is reserved because it changes how programs run; pick a different name (for example MY_PROXY_URL)');
  }
  return raw;
}

export function validSecretValue(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new ValidationError('value must be a non-empty string');
  if (raw.includes('\0')) throw new ValidationError('value must not contain NUL');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_VALUE_BYTES) throw new ValidationError(`value is too large (max ${MAX_SECRET_VALUE_BYTES / 1024} KB)`);
  return raw;
}

/** Moves a value that just left the live store into the capped retired list (newest last, no duplicates). */
function retire(store: Store, value: string, name: string): void {
  if (!redactable(value)) return;
  const rest = store.retired.filter(r => r.value !== value);
  rest.push({ value, name, retiredAt: Date.now() });
  store.retired = capRetired(rest);
}

/** Names and update times of a project's secrets, never the values. */
export function listSecrets(cwd: unknown): { project: string; names: { name: string; updatedAt: number }[] } {
  const project = projectRoot(cwd);
  const names = Object.entries(loadStore().projects[project] ?? {})
    .map(([name, s]) => ({ name, updatedAt: s.updatedAt }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { project, names };
}

export function putSecret(cwd: unknown, name: unknown, value: unknown): void {
  const project = projectRoot(cwd);
  const n = validSecretName(name);
  const v = validSecretValue(value);
  const store = structuredClone(loadStore());
  const own = (store.projects[project] ??= {});
  const previous = own[n];
  if (!previous && Object.keys(own).length >= MAX_SECRETS_PER_PROJECT) throw new ValidationError('too many secrets');
  own[n] = { value: v, updatedAt: Date.now() };
  if (previous && previous.value !== v) retire(store, previous.value, n);
  // All of a project's values land in one env block: keep it far below the exec argument limit.
  const projectBytes = Object.values(own).reduce((sum, s) => sum + Buffer.byteLength(s.value, 'utf8'), 0);
  if (projectBytes > MAX_PROJECT_SECRET_BYTES) {
    throw new ValidationError(`this project's secrets are too large (max ${MAX_PROJECT_SECRET_BYTES / 1024} KB in total)`);
  }
  if (Buffer.byteLength(JSON.stringify(store.projects), 'utf8') > MAX_STORE_WRITE_BYTES) throw new ValidationError('secret store full');
  saveStore(store);
}

/** Removing an unknown name is fine (idempotent). */
export function deleteSecret(cwd: unknown, name: unknown): void {
  const project = projectRoot(cwd);
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) throw new ValidationError('name must be a secret name');
  const store = structuredClone(loadStore());
  const own = store.projects[project];
  if (!own?.[name]) return;
  retire(store, own[name].value, name);
  delete own[name];
  if (Object.keys(own).length === 0) delete store.projects[project];
  saveStore(store);
}

// ---------------------------------------------------------------- injection

/** A session's project secrets; an unreadable store yields none (the session still starts). */
export function projectSecrets(cwd: string): SecretEntry[] {
  try {
    const own = loadStore().projects[projectRootLoose(cwd)] ?? {};
    return Object.entries(own).map(([name, s]) => ({ name, value: s.value }));
  } catch (err) {
    console.error('Secrets unavailable:', (err as Error).message);
    return [];
  }
}

// Values this process handed to agents, bounded (MAX_INJECTED_VALUES, least recently injected out first).
// A value deleted or rotated while its session is still running is gone from the live store but not
// from that session's output: keep redacting it. The retired list in the store covers restarts.
const injected = new Map<string, string>();
let injectedVersion = 0;

/**
 * Env vars of a session's project secrets, to merge over process.env, plus SWARMKIT_SECRET_NAMES
 * (comma-separated, sorted; names only) so the agent knows what it has. Empty without secrets.
 */
export function secretEnv(cwd: string): Record<string, string> {
  const entries = projectSecrets(cwd);
  if (entries.length === 0) return {};
  for (const e of entries) {
    if (injected.has(e.value)) {
      injected.delete(e.value); // re-insert: most recently injected goes last
    } else {
      injectedVersion++;
    }
    injected.set(e.value, e.name);
  }
  while (injected.size > MAX_INJECTED_VALUES) {
    injected.delete(injected.keys().next().value as string);
    injectedVersion++;
  }
  const names = entries.map(s => s.name).sort().join(',');
  return { ...Object.fromEntries(entries.map(s => [s.name, s.value])), SWARMKIT_SECRET_NAMES: names };
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

/** Worth redacting: long enough and varied enough to be a real secret (see MIN_REDACT_*). */
function redactable(value: string): boolean {
  return value.length >= MIN_REDACT_LENGTH && new Set(value).size >= MIN_REDACT_DISTINCT_CHARS;
}

/** One alternation, longest value first, so a single pass never re-scans a placeholder. */
function matcherFor(entries: SecretEntry[]): Matcher | null {
  const cached = matchers.get(entries);
  if (cached !== undefined) return cached;
  const names = new Map<string, string>();
  for (const e of entries) {
    if (!redactable(e.value)) continue;
    names.set(e.value, e.name);
    // Tool inputs travel as JSON text inside strings: match the escaped form too.
    const escaped = JSON.stringify(e.value).slice(1, -1);
    if (escaped !== e.value && !names.has(escaped)) names.set(escaped, e.name);
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

/** Replaces each secret value (see MIN_REDACT_*, longest first) with `[secret:NAME]`. */
export function redactSecrets(text: string, entries: SecretEntry[]): string {
  if (entries.length === 0 || text.length === 0) return text;
  const m = matcherFor(entries);
  if (!m) return text;
  return text.replace(m.regex, hit => `[secret:${m.names.get(hit) ?? 'REDACTED'}]`);
}

/** Deep string walk (keys too); arrays and plain objects are copied only where something changed. */
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
    const pairs = Object.entries(value);
    let out: [string, unknown][] | undefined;
    pairs.forEach(([key, item], i) => {
      const nextKey = redactSecrets(key, entries);
      const next = walk(item, entries);
      if (!out && (nextKey !== key || next !== item)) out = pairs.slice(0, i);
      out?.push([nextKey, next]);
    });
    // fromEntries defines own properties, so a key such as "__proto__" stays plain data.
    return out ? Object.fromEntries(out) : value;
  }
  return value;
}

let storeFailing = false;

/**
 * The store for redaction: the current file, or the last good copy when it cannot be read (fail closed).
 * Reused for REDACTION_RECHECK_MS so the broadcast hot path does not open the file per event; saveStore
 * drops it, so this process's own writes apply at once. The same Store object keeps the union matcher cached.
 */
function storeForRedaction(): Store {
  const file = secretsFilePath();
  const now = Date.now();
  if (redactionCache && redactionCache.file === file && now - redactionCache.at >= 0 && now - redactionCache.at < REDACTION_RECHECK_MS) {
    return redactionCache.store;
  }
  let store: Store;
  try {
    store = loadStore();
    storeFailing = false;
  } catch (err) {
    if (!storeFailing) {
      storeFailing = true;
      console.error('Secrets store unreadable, redacting with the last good copy:', (err as Error).message);
    }
    store = lastGood;
  }
  // A missing file is rechecked on every call: that is cheap (open fails at once) and never pins an empty store.
  if (store !== EMPTY_STORE) redactionCache = { file, at: now, store };
  else redactionCache = undefined;
  return store;
}

let union: { store: Store; version: number; entries: SecretEntry[] } | undefined;

/**
 * Every value that must never reach a browser: all projects' stored values, the retired ones and what
 * this process injected recently, deduplicated, longest first. A stable array until the store file or the
 * injected set changes, so the compiled matcher is reused for every event.
 */
export function allSecretEntries(): SecretEntry[] {
  const store = storeForRedaction();
  if (union && union.store === store && union.version === injectedVersion) return union.entries;
  const byValue = new Map<string, string>();
  for (const names of Object.values(store.projects)) {
    for (const [name, s] of Object.entries(names)) if (!byValue.has(s.value)) byValue.set(s.value, name);
  }
  for (const r of store.retired) if (!byValue.has(r.value)) byValue.set(r.value, r.name);
  for (const [value, name] of injected) if (!byValue.has(value)) byValue.set(value, name);
  const entries = [...byValue].map(([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
  union = { store, version: injectedVersion, entries };
  return entries;
}

/** Scrubs anything bound for a browser, a push or a new prompt; returns the same object when nothing changes. */
export function redactAll<T>(value: T): T {
  return redactDeep(value, allSecretEntries());
}

/** Scrubs one ServerEvent (every type, workers included) with the union of all secret values. */
export function redactServerEvent(event: ServerEvent): ServerEvent {
  return redactAll(event);
}

/** Test hook: forget the cached store, the last good copy and every injected value. */
export function resetSecretStateForTests(): void {
  loaded = undefined;
  lastGood = EMPTY_STORE;
  redactionCache = undefined;
  storeFailing = false;
  injected.clear();
  injectedVersion++;
  union = undefined;
}
