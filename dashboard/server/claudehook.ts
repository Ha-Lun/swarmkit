// Claude Code PermissionRequest hook bridge: a terminal (watched) session's
// AskUserQuestion / ExitPlanMode prompt is relayed to the dashboard, which answers it
// instead of the terminal dialog. The hook script finds this server through
// <config>/swarmkit/claude-hook.json ({socket, secret}) and POSTs to /api/claude-hook over the
// Unix domain socket next to it. A socket in a 0700 directory cannot be impersonated by another
// local user (a TCP port could be, after a crash), and nothing else is served on it.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { tokenFilePath } from './auth.ts';
import type { PermissionDecisionBody, PermissionRequest } from '../src/shared/types.ts';

const CLAUDE_HOOK_PATH = '/api/claude-hook';
/** The hook posts one tool call; the cap leaves room for a 100 KB plan plus JSON escaping. */
export const CLAUDE_HOOK_BODY_MAX = 256 * 1024;
/** Hold the hook connection at most this long (Claude Code's hook timeout is 900 s). */
const HOLD_MS = 870_000;
/** How long to wait for the watcher to learn a session that has no transcript file yet. */
const SESSION_WAIT_MS = 2000;
/** Pending prompts per session / overall; extra ones are handed back to the terminal. */
const MAX_PER_SESSION = 4;
const MAX_TOTAL = 16;
const PLAN_MAX = 100 * 1024;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

/** A visible-dashboard heartbeat counts for this long. */
const PRESENCE_TTL_MS = 90_000;
const MAX_PRESENCE = 64;

type HookMode = 'auto' | 'acceptEdits';
/**
 * The reply carries no input: the hook script builds updatedInput from its own tool_input
 * (plus the validated answers) and applies `mode` only to a plan approved from plan mode.
 */
type HookReply =
  | { decision: 'pass' }
  | { decision: 'allow'; answers?: Record<string, string>; mode?: HookMode }
  | { decision: 'deny'; message: string };

// ---------------------------------------------------------------------------
// presence
// ---------------------------------------------------------------------------

/**
 * Which dashboard tabs are visible right now. The terminal prompt is only held while some tab
 * reported visible:true within the last 90 s, so a forgotten background tab never blocks it.
 */
export class Presence {
  private readonly seen = new Map<string, { visible: boolean; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  set(id: string, visible: boolean): void {
    const at = this.now();
    this.seen.delete(id);
    this.seen.set(id, { visible, at });
    for (const [key, entry] of this.seen) {
      if (at - entry.at > PRESENCE_TTL_MS || this.seen.size > MAX_PRESENCE) this.seen.delete(key);
    }
  }

  anyVisible(): boolean {
    const at = this.now();
    for (const entry of this.seen.values()) if (entry.visible && at - entry.at <= PRESENCE_TTL_MS) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// hook file
// ---------------------------------------------------------------------------

export function claudeHookFilePath(): string {
  return path.join(path.dirname(tokenFilePath()), 'claude-hook.json');
}

export function claudeHookSocketPath(file = claudeHookFilePath()): string {
  return path.join(path.dirname(file), 'claude-hook.sock');
}

/** Atomically writes {socket, secret} (temp file in the same dir, mode 0600, then rename). */
export function writeClaudeHookFile(socket: string, secret: string, file = claudeHookFilePath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ socket, secret }), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Removes the hook file and its socket, but only while the file still holds our secret
 * (a newer server may own both).
 */
export function removeClaudeHookFile(secret: string, file = claudeHookFilePath()): void {
  try {
    const current = JSON.parse(readFileSync(file, 'utf8')) as { secret?: unknown };
    if (current.secret !== secret) return;
    rmSync(file, { force: true });
    rmSync(claudeHookSocketPath(file), { force: true });
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

/** Creates the config dir if needed and insists it is a real directory, ours, and 0700. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid!()) throw new Error('hook directory is not a directory owned by this user');
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

/** Unlinks a leftover socket from a crashed server; refuses anything that is not our own socket. */
function removeStaleSocket(sock: string): void {
  let st;
  try {
    st = lstatSync(sock);
  } catch {
    return;
  }
  if (!st.isSocket() || st.uid !== process.getuid!()) throw new Error('hook socket path is occupied by something else');
  unlinkSync(sock);
}

export interface HookSocketServer {
  server: Server;
  socketPath: string;
  close(): Promise<void>;
}

/**
 * Serves POST /api/claude-hook, and nothing else, on <config>/swarmkit/claude-hook.sock (0600
 * in a 0700 dir). Whoever can connect is the user, so the shared secret is the only further check.
 */
export async function startClaudeHookServer(ctx: HookRouteContext, file = claudeHookFilePath()): Promise<HookSocketServer> {
  const dir = path.dirname(file);
  const socketPath = claudeHookSocketPath(file);
  ensurePrivateDir(dir);
  removeStaleSocket(socketPath);
  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '').split('?')[0];
    const run = pathname === CLAUDE_HOOK_PATH ? handleClaudeHookRoute(req, res, ctx) : Promise.resolve(reply(res, 404, { error: 'not found' }));
    void run.catch(() => {
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
      else res.destroy();
    });
  });
  // The socket is created with the umask applied: 0077 keeps it private from the first instant.
  const oldUmask = process.umask(0o077);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(oldUmask);
  }
  try {
    chmodSync(socketPath, 0o600);
  } catch (err) {
    server.close();
    throw err;
  }
  return {
    server,
    socketPath,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------------------
// body validation and display copy
// ---------------------------------------------------------------------------

interface HookBody {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  transcriptPath?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shape check only; null means a malformed request (400). */
export function parseHookBody(raw: unknown): HookBody | null {
  if (!isObject(raw)) return null;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput } = raw;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > 200) return null;
  if (!isObject(toolInput)) return null;
  if (raw.transcript_path !== undefined && typeof raw.transcript_path !== 'string') return null;
  const transcriptPath = typeof raw.transcript_path === 'string' ? raw.transcript_path : undefined;
  return { sessionId, toolName, toolInput, ...(transcriptPath !== undefined ? { transcriptPath } : {}) };
}

const cap = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * The copy shown to the dashboard: only the known keys, strings capped. null when the
 * input is not renderable (the terminal dialog handles it instead). Answers are keyed by the
 * exact question text of the original input, which the hook script re-checks against its own.
 */
export function displayInput(tool: 'AskUserQuestion' | 'ExitPlanMode', input: Record<string, unknown>): Record<string, unknown> | null {
  if (tool === 'ExitPlanMode') {
    const plan = cap(input.plan, PLAN_MAX);
    if (plan === undefined) return null;
    const planFilePath = cap(input.planFilePath, 1000);
    return { plan, ...(planFilePath ? { planFilePath } : {}) };
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;
  const questions: Record<string, unknown>[] = [];
  for (const q of input.questions.slice(0, 4)) {
    if (!isObject(q)) return null;
    const question = cap(q.question, 4000);
    if (!question || !Array.isArray(q.options)) return null;
    const options = q.options.slice(0, 12).flatMap(o => {
      const label = isObject(o) ? cap(o.label, 500) : undefined;
      if (!label) return [];
      return [{ label, description: cap((o as Record<string, unknown>).description, 2000) ?? '' }];
    });
    const header = cap(q.header, 200);
    questions.push({ question, ...(header ? { header } : {}), multiSelect: q.multiSelect === true, options });
  }
  return { questions };
}

// ---------------------------------------------------------------------------
// bridge
// ---------------------------------------------------------------------------

/** The slice of TranscriptWatcher the bridge needs. */
export interface HookWatcher {
  hasSession(id: string, waitMs?: number): Promise<boolean>;
  /** The transcript file the watcher follows for this session, if known. */
  transcriptPath(id: string): string | undefined;
  addTerminalPermission(request: PermissionRequest): void;
  removeTerminalPermission(sessionId: string, id: string, allow: boolean): boolean;
}

export interface BridgeOptions {
  watcher: HookWatcher;
  /** True for page sessions (their canUseTool already handles the prompt). */
  owns: (sessionId: string) => boolean;
  /** True while an authenticated dashboard tab reports itself visible (see Presence). */
  dashboardOpen: () => boolean;
  holdMs?: number;
  sessionWaitMs?: number;
}

interface Held {
  sessionId: string;
  tool: string;
  settle: (reply: HookReply, allow: boolean) => void;
}

/** True when both paths resolve to the same existing file. */
function sameFile(given: string | undefined, known: string | undefined): boolean {
  if (!given || !known) return false;
  try {
    return realpathSync(given) === realpathSync(known);
  } catch {
    return false;
  }
}

export class ClaudeHookBridge {
  private readonly held = new Map<string, Held>();
  private readonly opts: BridgeOptions;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  /**
   * Relays one hook call: resolves with the dashboard's decision, or 'pass' (let the
   * terminal dialog run) when the dashboard cannot or should not answer it.
   */
  async request(body: HookBody, signal: AbortSignal): Promise<HookReply> {
    const pass: HookReply = { decision: 'pass' };
    const { sessionId, toolName, toolInput } = body;
    if (toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') return pass;
    if (this.opts.owns(sessionId) || !this.opts.dashboardOpen()) return pass;
    const input = displayInput(toolName, toolInput);
    if (!input || this.full(sessionId)) return pass;
    if (!(await this.opts.watcher.hasSession(sessionId, this.opts.sessionWaitMs ?? SESSION_WAIT_MS))) return pass;
    if (!sameFile(body.transcriptPath, this.opts.watcher.transcriptPath(sessionId))) return pass;
    // Re-check: the dashboard may have closed, or other hooks arrived, during the wait.
    if (signal.aborted || this.opts.owns(sessionId) || !this.opts.dashboardOpen() || this.full(sessionId)) return pass;

    const request: PermissionRequest = {
      id: randomUUID(),
      sessionId,
      nodeId: 'root',
      tool: toolName,
      kind: toolName === 'AskUserQuestion' ? 'question' : 'plan',
      input,
      terminal: true,
      createdAt: Date.now(),
    };
    return new Promise<HookReply>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (reply: HookReply, allow: boolean): void => {
        if (!this.held.delete(request.id)) return;
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.opts.watcher.removeTerminalPermission(sessionId, request.id, allow);
        resolve(reply);
      };
      const onAbort = (): void => settle(pass, false);
      this.held.set(request.id, { sessionId, tool: toolName, settle });
      signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => settle(pass, false), this.opts.holdMs ?? HOLD_MS);
      timer.unref();
      this.opts.watcher.addTerminalPermission(request);
    });
  }

  /** Applies a dashboard decision to a held hook call; false when the id is not ours. */
  decide(id: string, body: PermissionDecisionBody): boolean {
    const entry = this.held.get(id);
    if (!entry) return false;
    if (body.terminal) {
      entry.settle({ decision: 'pass' }, false);
    } else if (!body.allow) {
      entry.settle({ decision: 'deny', message: body.message || 'Denied in SwarmKit' }, false);
    } else if (entry.tool === 'AskUserQuestion') {
      entry.settle({ decision: 'allow', ...(body.answers ? { answers: body.answers } : {}) }, true);
    } else {
      entry.settle({ decision: 'allow', ...(body.mode ? { mode: body.mode } : {}) }, true);
    }
    return true;
  }

  /** Hands every held prompt back to the terminal (server shutdown). */
  releaseAll(): void {
    for (const entry of [...this.held.values()]) entry.settle({ decision: 'pass' }, false);
  }

  private full(sessionId: string): boolean {
    if (this.held.size >= MAX_TOTAL) return true;
    let n = 0;
    for (const e of this.held.values()) if (e.sessionId === sessionId) n++;
    return n >= MAX_PER_SESSION;
  }
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

export interface HookRouteContext {
  bridge: ClaudeHookBridge;
  secret: string;
}

function reply(res: ServerResponse, status: number, body: unknown, close = false): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...(close ? { Connection: 'close' } : {}) });
  res.end(JSON.stringify(body));
}

/** Constant-time compare of two secrets of any length (digests are fixed-size). */
function secretMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Reads the body up to the cap; null when it was larger (the rest is drained and dropped). */
function readCapped(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > max) {
        over = true;
        chunks.length = 0;
      } else if (!over) {
        chunks.push(buf);
      }
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** POST /api/claude-hook: arrives on the private socket + shared secret, never the fleet token. Errors carry no detail. */
export async function handleClaudeHookRoute(req: IncomingMessage, res: ServerResponse, ctx: HookRouteContext): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') return reply(res, 405, { error: 'method not allowed' });
  const given = req.headers['x-swarmkit-hook'];
  if (typeof given !== 'string' || given.length === 0 || !secretMatches(given, ctx.secret)) {
    return reply(res, 401, { error: 'unauthorized' });
  }
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !contentType.includes('application/json')) {
    return reply(res, 400, { error: 'bad request' });
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > CLAUDE_HOOK_BODY_MAX) return reply(res, 413, { error: 'too large' }, true);
  const raw = await readCapped(req, CLAUDE_HOOK_BODY_MAX);
  if (raw === null) return reply(res, 413, { error: 'too large' }, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return reply(res, 400, { error: 'bad request' });
  }
  const body = parseHookBody(parsed);
  if (!body) return reply(res, 400, { error: 'bad request' });

  // The hook caller going away (killed claude, hook timeout) withdraws the prompt.
  const closer = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) closer.abort();
  });
  const out = await ctx.bridge.request(body, closer.signal);
  if (!res.writableEnded && !res.destroyed) reply(res, 200, out);
}
