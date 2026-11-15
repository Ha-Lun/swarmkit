// Page sessions driven by the Claude Agent SDK: one query per browser-started session,
// permission prompts resolved from the dashboard, a live agent tree per session.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult, SDKMessage, SDKRateLimitEvent, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyMessage, createTree, ownerOf, setStatus, upsertEvent } from '../model/reducer.ts';
import type { SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';
import { noteRateLimit } from '../usage.ts';
import { DASHBOARD_ENTRYPOINTS, holderMessage, liveHolder } from '../livesessions.ts';
import { MAX_EVENTS, RUNTIME_MODELS } from '../../src/shared/types.ts';
import type { AgentNode, FileAttachment, ImageAttachment, LimitReached, PermissionDecisionBody, PermissionRequest, ResumeSessionBody, Runtime, ServerEvent, SessionDetail, SessionSummary, SlashCommandInfo, StartSessionBody, TriageInfo } from '../../src/shared/types.ts';
import { AGENT_RE, validAttachmentTotals, validEffort, validFiles, validImages, validMessageText, validResumeModel, validText } from '../validate.ts';
import { createAcpQuery } from '../runtimes/acp.ts';
import type { AcpOptions } from '../runtimes/acp.ts';
import { AgyHookBridge, createAgyQuery } from '../runtimes/agy.ts';
import { listAgyCommands } from '../runtimes/agy-commands.ts';
import type { AgyHookResponse, AgyOptions } from '../runtimes/agy.ts';
import { claudeConfigDir, resolveDirInHome } from '../paths.ts';
import { CommandCache } from '../commandcache.ts';
import { deleteImages, imageDir, pruneOrphanImages, saveFiles, saveImages } from '../images.ts';
import { deleteArtifacts, ensureArtifactDir, pruneOrphanArtifacts } from '../artifacts.ts';

/** Main-thread agent names must start alphanumerically and stay short (no '../', no path tricks). */
export { AGENT_RE };

/** Throttle for session.upsert broadcasts: at most one per this many ms per session. */
const UPSERT_MS = 250;
/** Interval for polling worker result files of running sessions. */
const POLL_MS = 3_000;
/** A transcript written within this window means a terminal session is still live. */
const ACTIVE_MS = 60_000;
/** Resume waits at most this long for the previous consume() to unwind. */
const RESUME_UNWIND_MS = 5_000;
/** Finished page sessions drop out of memory after this long (the watcher re-lists their transcripts). */
export const EVICT_AFTER_MS = 6 * 60 * 60 * 1000;
/** Max page sessions kept in memory (oldest finished ones are evicted first). */
export const MAX_PAGE_SESSIONS = 50;

/** Typed error so the HTTP layer can answer with the right status code. */
export class SessionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Extra start options, internal only (the POST body validation never takes them). */
export interface PageStartOptions extends StartSessionBody {
  /** Keep the old title instead of the prompt's first line (fallback leads). */
  title?: string;
  /** The Claude session this fallback lead continues. */
  fallbackOf?: { sessionId: string; title: string };
  /** Haiku triage classification when triage picked the start model. */
  triage?: TriageInfo;
}

/** Called once per session when a Claude turn is refused by the plan limit. */
export interface SessionHooks {
  onLimit?: (sessionId: string, info: { window: string; resetsAt: string | null }) => void;
}

/** rateLimitType values that count as a plan-limit hit (usage.ts only records a subset). */
const LIMIT_WINDOWS = new Set([
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'overage',
]);

/** An assistant rate_limit error only counts when its text names the plan limit. */
const LIMIT_TEXT_RE = /usage limit|limit reached/i;

/** Text of an assistant message: explicit text, content blocks, then result strings. */
function assistantErrorText(message: unknown): string {
  const m = message as {
    text?: unknown;
    result?: unknown;
    message?: { content?: unknown };
  };
  const parts: string[] = [];
  if (typeof m?.text === 'string') parts.push(m.text);
  const content = m?.message?.content;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string') parts.push(text);
      }
    }
  }
  if (typeof m?.result === 'string') parts.push(m.result);
  return parts.join('\n');
}

/** Injectable so tests can drive a fake query. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/** What the caller knows about the session being resumed (page-owned or terminal). */
export interface ResumeInfo {
  cwd: string;
  /** Transcript mtime; within the last minute means the session is still live in a terminal. */
  transcriptMtimeMs?: number;
  /** Prior tree nodes (from the transcript watcher) the tree is rebuilt from. */
  nodes?: AgentNode[];
  /** First line of the old title, used as the rebuilt root prompt when there are no nodes. */
  title?: string;
}

/** Minimal push/close queue used as the SDK's streaming prompt input. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  /** Called when the reader takes a message (the turn that answers it starts). */
  onTake?: (message: SDKUserMessage) => void;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      this.onTake?.(message);
      waiter({ value: message, done: false });
    } else this.items.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) {
          this.onTake?.(item);
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<SDKUserMessage>>(resolve => this.waiters.push(resolve));
      },
    };
  }
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (result: PermissionResult) => void;
}

interface PageSession {
  id: string;
  cwd: string;
  agent?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Which lead runtime drives this session ('claude' = the Claude Agent SDK query). */
  runtime: Runtime;
  /** Latest lead conversation id reported by the acp/agy adapter (for resume). */
  runtimeSessionId?: string;
  /** Directory of this session's stored images, once it has any (agy gets it via --add-dir). */
  imagesDir?: string;
  /** agy hook secret for POST /api/agy-hook/:id (agy runtime only). */
  hookSecret?: string;
  /** Lead model for this session (default for the next resume and summary fallback before init). */
  model?: string;
  /** Haiku triage outcome when triage picked the start model. */
  triage?: TriageInfo;
  /** First line of the first prompt, clamped to 120 chars for the title. */
  title: string;
  startedAt: number;
  updatedAt: number;
  tree: SessionTree;
  queue: InputQueue;
  /** Page messages waiting for the current opencode/agy turn to end (see markQueued). */
  queuedUuids?: Set<string>;
  abort: AbortController;
  query: AsyncIterable<SDKMessage> | null;
  pending: Map<string, PendingPermission>;
  stopped: boolean;
  /** True while consume() runs; the source of truth for "a live SDK process exists". */
  consuming: boolean;
  /** Bumped on every startQuery; stale consume()/canUseTool calls ignore their stream. */
  generation: number;
  consumePromise: Promise<void> | null;
  /** True when the cwd's project settings are untrusted (only user settings are read). */
  untrustedProject: boolean;
  /** The SDK session's current permission mode (seeded at startQuery, kept up to date from system messages). */
  permissionMode?: NonNullable<Options['permissionMode']>;
  /** Set when a Claude turn is refused by the plan limit (server/fallback.ts). */
  limitHit?: { window: string; resetsAt: string | null };
  /** Mirrors limitHit for summaries; the limit handler fills in the fallback. */
  limitReached?: LimitReached;
  /** onLimit has been called for this session (exactly once per session). */
  limitNotified?: boolean;
  /** Set on a fallback lead: the Claude session it continues (never falls back again). */
  fallbackOf?: { sessionId: string; title: string };
  /** Terminal slash commands from the init message (filtered out of commands()). */
  terminalCommands?: Set<string>;
  upsertThrottle: { lastSent: number; timer: NodeJS.Timeout | null };
}

/** The string-valued entries of a decision's answers object, undefined when there are none. */
function stringAnswers(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, a] of Object.entries(v)) if (typeof a === 'string' && a.length > 0) out[k] = a;
  return Object.keys(out).length > 0 ? out : undefined;
}

const firstPromptLine = (prompt: string): string => {
  const line = prompt.split('\n', 1)[0] ?? prompt;
  return line.length > 120 ? line.slice(0, 120) : line;
};

const isOpusModel = (model: string | undefined): boolean =>
  model === 'opus' || (model?.startsWith('claude-opus') ?? false);

/** ~/.claude.json marks trusted projects: only then are project/local settings read (untrusted files are attacker-controlled). */
function isProjectTrusted(cwd: string): boolean {
  const candidates = [cwd];
  try {
    candidates.push(realpathSync(cwd));
  } catch {
    // Non-existing cwd: definitely untrusted.
  }
  try {
    const raw = readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
    const config = JSON.parse(raw) as { projects?: unknown };
    const projects = config.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return false;
    const byDir = projects as Record<string, { hasTrustDialogAccepted?: unknown }>;
    return candidates.some(dir => byDir[dir]?.hasTrustDialogAccepted === true);
  } catch {
    return false;
  }
}

const TERMINAL_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] as const;

/** The mode `claude` starts in: user settings permissions.defaultMode, else auto. Never bypassPermissions. */
function terminalPermissionMode(): NonNullable<Options['permissionMode']> {
  try {
    const raw = readFileSync(path.join(claudeConfigDir(), 'settings.json'), 'utf8');
    const mode = (JSON.parse(raw) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
    const match = TERMINAL_MODES.find(m => m === mode);
    if (match) return match;
  } catch {
    // Missing or corrupt settings.json: fall back to auto.
  }
  return 'auto';
}

/** Same cwd contract as the start path (index.ts resolveCwd): must exist, be a directory, inside $HOME. */
async function resolveResumeCwd(raw: string | undefined): Promise<string> {
  const resolved = await resolveDirInHome(raw);
  if ('error' in resolved) throw new SessionError(400, resolved.error);
  return resolved.dir;
}

/** Transcript path for an SDK session id, using the watcher's project-dir encoding. */
export function transcriptPathFor(cwd: string, sessionId: string): string {
  return path.join(claudeConfigDir(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

/**
 * Completed-turn probe: the tail of the transcript names an assistant or result message.
 * Cached per (mtime, size) so repeated summaries cost at most two stats; a session that
 * died before the first response has only user lines and reads as not resumable.
 */
const turnCache = new Map<string, { key: string; value: boolean }>();

export function transcriptHasTurn(file: string, mtimeMs: number, size: number): boolean {
  const key = `${file}:${mtimeMs}:${size}`;
  const hit = turnCache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value = false;
  try {
    const fd = openSync(file, 'r');
    try {
      const len = Math.min(32 * 1024, size);
      if (len > 0) {
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, Math.max(0, size - len));
        const tail = buf.toString('utf8');
        value = tail.includes('"type":"assistant"') || tail.includes('"type":"result"');
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    value = false;
  }
  if (turnCache.size > 500) turnCache.clear();
  turnCache.set(file, { key, value });
  return value;
}

/**
 * Could POST /api/sessions/:id/resume succeed for this page session? Ended terminal
 * states only (running/waiting/idle stay live), plus the transcript file, the cwd
 * directory and one completed turn. Cheap synchronous fs checks only.
 */
export function pageResumable(
  sessionId: string,
  cwd: string,
  status: SessionSummary['status'],
): boolean {
  if (status !== 'done' && status !== 'error' && status !== 'stopped') return false;
  try {
    if (!statSync(cwd).isDirectory()) return false;
  } catch {
    return false;
  }
  const file = transcriptPathFor(cwd, sessionId);
  let st;
  try {
    st = statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  return transcriptHasTurn(file, st.mtimeMs, st.size);
}

export class SdkSessions {
  private sessions = new Map<string, PageSession>();
  private pollTimer: NodeJS.Timeout;
  private lastImagePrune = 0;
  /** Session ids with a pollWorkers call in flight (one poll at a time per session). */
  private polling = new Set<string>();
  /** Permission-hook bridge for agy runtime sessions (one handler per hook secret). */
  private readonly bridge = new AgyHookBridge();
  private readonly acpFactory: (o: AcpOptions) => QueryFn;
  private readonly agyFactory: (o: AgyOptions) => QueryFn;
  private readonly hookBase: () => string;

  constructor(
    private emit: (e: ServerEvent) => void,
    private queryFn: QueryFn = query,
    runtimes?: { acp?: (o: AcpOptions) => QueryFn; agy?: (o: AgyOptions) => QueryFn; hookBase?: () => string; commandCacheFile?: string },
    private hooks?: SessionHooks,
  ) {
    this.commandCache = new CommandCache(runtimes?.commandCacheFile ?? null);
    this.acpFactory = runtimes?.acp ?? createAcpQuery;
    this.agyFactory = runtimes?.agy ?? createAgyQuery;
    this.hookBase = runtimes?.hookBase ?? (() => 'http://127.0.0.1:4317');
    this.pruneImages();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.pollTimer.unref();
  }

  /** Starts a session in the background and returns its id at once. */
  start(body: PageStartOptions): string {
    const id = randomUUID();
    const startedAt = Date.now();
    const runtime = body.runtime ?? 'claude';
    const tree = createTree(id, { startedAt, agentType: 'lead-dev-hybrid', prompt: body.prompt });
    const session: PageSession = {
      id,
      cwd: body.cwd,
      agent: 'lead-dev-hybrid',
      ...(body.effort ? { effort: body.effort } : {}),
      runtime,
      ...(body.model ? { model: body.model } : {}),
      ...(body.triage ? { triage: { ...body.triage } } : {}),
      title: body.title ?? firstPromptLine(body.prompt),
      ...(body.fallbackOf ? { fallbackOf: { ...body.fallbackOf } } : {}),
      startedAt,
      updatedAt: startedAt,
      tree,
      queue: new InputQueue(),
      abort: new AbortController(),
      query: null,
      pending: new Map(),
      stopped: false,
      consuming: false,
      generation: 0,
      consumePromise: null,
      untrustedProject: false,
      upsertThrottle: { lastSent: 0, timer: null },
    };
    this.sessions.set(id, session);

    try {
      this.startQuery(session, body.prompt, body.model, body.effort, false, body.images, body.files);
    } catch (err) {
      this.sessions.delete(id);
      deleteImages(id);
      deleteArtifacts(id);
      throw err;
    }
    return id;
  }

  /** Sets (or replaces) the plan-limit handler after construction (index.ts wiring). */
  setOnLimit(onLimit: SessionHooks['onLimit']): void {
    this.hooks = { ...this.hooks, onLimit };
  }

  /** Current permission mode of a page session, for the fallback handoff. */
  permissionModeOf(id: string): string | undefined {
    return this.sessions.get(id)?.permissionMode;
  }

  /**
   * Records the fallback outcome of a plan-limit hit and broadcasts the old
   * session's summary again (its limitReached now names the new lead, or null
   * when no lane was free). No-op without a recorded limit hit.
   */
  resolveLimit(id: string, fallback: LimitReached['fallback']): void {
    const session = this.sessions.get(id);
    if (!session || !session.limitHit) return;
    session.limitReached = { ...session.limitHit, fallback };
    this.flushUpsert(session);
  }

  /** Runs the SDK query for a session (fresh start or resumed continuation) and consumes it in the background. */
  private startQuery(session: PageSession, prompt: string | undefined, model: string | undefined, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, resume: boolean, images?: ImageAttachment[], files?: FileAttachment[]): void {
    // Store the attachments first: a disk error must not leave a half-started query behind.
    // A restart without text prepares no turn: the fresh process just waits for input.
    const turn = prompt !== undefined ? this.prepareTurn(session, prompt, images, files) : undefined;
    session.queue.onTake = m => this.unqueue(session, m.uuid ?? '');
    session.generation += 1;
    const generation = session.generation;
    session.abort = new AbortController();
    // Untrusted projects only get user settings: project/local settings files would be attacker-controlled.
    session.untrustedProject = !isProjectTrusted(session.cwd);
    const artifactsDir = this.artifactsDirFor(session);
    if (session.runtime === 'claude') {
      const options: Options = {
        cwd: session.cwd,
        abortController: session.abort,
        settingSources: session.untrustedProject ? ['user'] : ['user', 'project', 'local'],
        forwardSubagentText: true,
        // The SDK defaults to 'default' when permissionMode is omitted (unlike the interactive CLI), so pass it explicitly.
        // Trusted: the terminal's mode (permissions.defaultMode, else auto); untrusted: always ask.
        permissionMode: (session.permissionMode = session.untrustedProject ? 'default' : terminalPermissionMode()),
        canUseTool: this.makeCanUseTool(session, generation),
        // $SWARMKIT_ARTIFACTS_DIR: where the lead puts files for the user to download (GET /api/sessions/:id/artifacts).
        ...(artifactsDir
          ? { env: { ...(process.env as Record<string, string>), SWARMKIT_ARTIFACTS_DIR: artifactsDir }, additionalDirectories: [artifactsDir] }
          : {}),
        // A resumed session keeps its id and drops the fixed sessionId (the SDK continues the old one).
        ...(resume ? { resume: session.id } : { sessionId: session.id }),
        ...(session.agent ? { agent: session.agent } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      };
      session.query = this.queryFn({ prompt: session.queue, options });
    } else {
      session.query = this.startRuntimeQuery(session, generation, model, effort, resume, artifactsDir);
    }
    if (turn) session.queue.push(turn.message);
    session.consumePromise = this.consume(session, generation).catch(err => {
      console.error(`Session ${session.id} consume crashed:`, err);
    });
    if (resume) {
      // A text-less restart leaves the root idle (the post-turn state), exactly as if no turn runs yet.
      for (const event of setStatus(session.tree, 'root', turn ? 'running' : 'idle')) this.emit(event);
    }
    this.scheduleUpsert(session);
    if (turn) for (const event of turn.events) this.emit(event);
  }

  /**
   * The queued user message of one turn. Without attachments it is the plain text. Images are
   * stored (private files) and the turn carries them per runtime: claude/opencode as base64
   * image blocks before the text, agy as the file paths appended to the text (it reads them with
   * read_file). Files are stored the same way and appended as absolute paths for every runtime
   * (Claude included: it reads them with its file tools). `events` is the user ActivityEvent
   * with the stored-image URLs and file display names (never base64).
   */
  private prepareTurn(session: PageSession, text: string, images?: ImageAttachment[], files?: FileAttachment[]): { message: SDKUserMessage; events: ServerEvent[] } {
    const base = { type: 'user' as const, parent_tool_use_id: null, session_id: session.id };
    const hasImages = !!images && images.length > 0;
    const hasFiles = !!files && files.length > 0;
    if (!hasImages && !hasFiles) {
      // The SDK and the adapters never echo page-sent text, so the user event is made here.
      const uuid = randomUUID();
      const events = applyMessage(session.tree, { type: 'user', uuid, message: { role: 'user', content: text } }, { pageUser: {} });
      return { message: { ...base, uuid, message: { role: 'user', content: text } }, events };
    }
    let urls: string[] = [];
    let imagePaths: string[] = [];
    if (hasImages) {
      try {
        const stored = saveImages(session.id, images!);
        session.imagesDir = imageDir(session.id);
        urls = stored.urls;
        imagePaths = stored.paths;
      } catch (err) {
        console.error(`Session ${session.id}: could not store images:`, (err as Error).message);
        throw new SessionError(500, 'could not store the images');
      }
    }
    let names: string[] = [];
    let filePaths: string[] = [];
    if (hasFiles) {
      try {
        const stored = saveFiles(session.id, files!);
        session.imagesDir = imageDir(session.id);
        names = stored.names;
        filePaths = stored.paths;
      } catch (err) {
        console.error(`Session ${session.id}: could not store files:`, (err as Error).message);
        throw new SessionError(500, 'could not store the files');
      }
    }
    // Files travel as paths for every runtime; the agent reads them from disk with its tools.
    // Quoted: names may contain spaces, so an unquoted paste into a shell would split them.
    const withFiles = filePaths.length > 0
      ? `${text}\n\nAttached files (read them from these paths):\n${filePaths.map(p => JSON.stringify(p)).join('\n')}`
      : text;
    const uuid = randomUUID();
    const content = session.runtime === 'agy'
      ? (imagePaths.length > 0
        ? `${withFiles}\n\nAttached images (open them with read_file):\n${imagePaths.join('\n')}`
        : withFiles)
      : [
          ...(images ?? []).map(i => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType, data: i.data } })),
          { type: 'text' as const, text: withFiles },
        ];
    // The same uuid lets a replayed/echoed copy of this message dedupe against the event below.
    const events = applyMessage(session.tree, {
      type: 'user',
      uuid,
      message: { role: 'user', content: text },
    }, { pageUser: { images: urls, files: names } });
    return { message: { ...base, uuid, message: { role: 'user', content } }, events };
  }

  /**
   * Starts an acp/agy lead query for a non-Claude session: the same queue/consume
   * machinery, but the adapter factory replaces the SDK query. Only cwd,
   * abortController, canUseTool and the session identity travel in the options;
   * model/effort/agent go to the factory (no settingSources/permissionMode/agent).
   */
  /** The session's artifact dir (created), or undefined when the store can't be made (the session still runs). */
  private artifactsDirFor(session: PageSession): string | undefined {
    try {
      return ensureArtifactDir(session.id);
    } catch (err) {
      console.error(`Session ${session.id}: no artifact dir:`, (err as Error).message);
      return undefined;
    }
  }

  private startRuntimeQuery(session: PageSession, generation: number, model: string | undefined, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, resume: boolean, artifactsDir?: string): AsyncIterable<SDKMessage> {
    const canUse = this.makeCanUseTool(session, generation);
    const options: Options = {
      cwd: session.cwd,
      abortController: session.abort,
      canUseTool: canUse,
      ...(resume ? { resume: session.id } : { sessionId: session.id }),
    };
    const onSessionId = (runtimeSessionId: string): void => {
      session.runtimeSessionId = runtimeSessionId;
    };
    if (session.runtime === 'opencode') {
      return this.acpFactory({
        ...(model ? { model } : {}),
        ...(resume && session.runtimeSessionId ? { resumeId: session.runtimeSessionId } : {}),
        onSessionId,
        currentModel: () => session.model,
        ...(artifactsDir ? { env: { ...process.env, SWARMKIT_ARTIFACTS_DIR: artifactsDir } } : {}),
      })({ prompt: session.queue, options });
    }
    // A fresh secret per generation: a lingering old agy process cannot get prompts in the new one.
    if (session.hookSecret) this.bridge.unregister(session.hookSecret);
    const secret = randomBytes(32).toString('hex');
    session.hookSecret = secret;
    this.bridge.register(secret, async (req, signal) => {
      let decision;
      try {
        decision = await canUse(req.tool, req.input, {
          signal: signal ? AbortSignal.any([session.abort.signal, signal]) : session.abort.signal,
          toolUseID: req.toolUseId,
          requestId: req.toolUseId,
          ...(req.title ? { title: req.title } : {}),
        });
      } catch {
        return { allow: false, reason: 'permission check failed' };
      }
      if (decision && decision.behavior === 'allow') {
        // A question's answers travel back so the agy bridge can phrase them for the model.
        const answers = req.tool === 'AskUserQuestion' ? stringAnswers((decision as { updatedInput?: { answers?: unknown } }).updatedInput?.answers) : undefined;
        return answers ? { allow: true, answers } : { allow: true };
      }
      const message = (decision as { message?: unknown }).message;
      return typeof message === 'string' && message ? { allow: false, reason: message } : { allow: false };
    });
    return this.agyFactory({
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      agent: 'lead-dev-hybrid',
      ...(resume && session.runtimeSessionId ? { resumeId: session.runtimeSessionId } : {}),
      onSessionId,
      hook: { url: `${this.hookBase()}/api/agy-hook/${session.id}`, secret },
      imagesDir: () => session.imagesDir,
      ...(artifactsDir ? { artifactsDir } : {}),
      currentModel: () => session.model,
    })({ prompt: session.queue, options });
  }

  /** Records a plan-limit hit from a rate_limit_event (rejected status, known window). */
  private recordLimitEvent(session: PageSession, message: SDKRateLimitEvent): void {
    if (session.runtime !== 'claude' || session.fallbackOf || session.stopped || session.limitHit) return;
    const info = (message as unknown as { rate_limit_info?: unknown }).rate_limit_info as
      | { status?: unknown; rateLimitType?: unknown; resetsAt?: unknown }
      | undefined;
    if (info?.status !== 'rejected') return;
    if (typeof info.rateLimitType !== 'string' || !LIMIT_WINDOWS.has(info.rateLimitType)) return;
    const resetsAt =
      typeof info.resetsAt === 'number' && info.resetsAt > 0
        ? new Date(info.resetsAt * 1000).toISOString()
        : null;
    session.limitHit = { window: info.rateLimitType, resetsAt };
    session.limitReached = { window: info.rateLimitType, resetsAt, fallback: null };
  }

  /** Records a plan-limit hit from an assistant rate_limit error naming the limit. */
  private recordAssistantLimit(session: PageSession, message: SDKMessage): void {
    if (session.runtime !== 'claude' || session.fallbackOf || session.stopped || session.limitHit) return;
    if (((message as unknown) as { error?: unknown }).error !== 'rate_limit') return;
    if (!LIMIT_TEXT_RE.test(assistantErrorText(message))) return;
    session.limitHit = { window: 'five_hour', resetsAt: null };
    session.limitReached = { window: 'five_hour', resetsAt: null, fallback: null };
  }

  /** Consumes the SDK iterator and broadcasts tree events + throttled summaries. */
  private async consume(session: PageSession, generation: number): Promise<void> {
    session.consuming = true;
    try {
      for await (const message of session.query as AsyncIterable<SDKMessage>) {
        if (generation !== session.generation) break; // Session restarted: this stream is obsolete.
        if ((message as { type?: string }).type === 'rate_limit_event') {
          // Feed the latest-known plan limits to /api/usage.
          noteRateLimit((message as SDKRateLimitEvent).rate_limit_info);
          this.recordLimitEvent(session, message as SDKRateLimitEvent);
        }
        if ((message as { type?: string }).type === 'assistant') {
          this.recordAssistantLimit(session, message);
        }
        const init = message as unknown as { type?: unknown; subtype?: unknown; terminal_slash_commands?: unknown; permissionMode?: unknown };
        if (init.type === 'system' && (init.subtype === 'init' || init.subtype === 'status') && typeof init.permissionMode === 'string') {
          session.permissionMode = init.permissionMode as NonNullable<Options['permissionMode']>;
        }
        if (init.type === 'system' && init.subtype === 'init' && Array.isArray(init.terminal_slash_commands)) {
          session.terminalCommands = new Set(
            init.terminal_slash_commands.filter((v): v is string => typeof v === 'string'),
          );
        }
        // Seed the per-cwd command list once, so terminal and ended sessions there get a menu too.
        if (init.type === 'system' && init.subtype === 'init' && !this.commandCache.has(session.runtime, session.cwd)) {
          void this.commands(session.id).catch(() => {});
        }
        for (const event of applyMessage(session.tree, message)) this.emit(event);
        if (
          (message as { type?: string }).type === 'result' &&
          session.limitHit &&
          !session.limitNotified &&
          session.runtime === 'claude' &&
          !session.fallbackOf &&
          !session.stopped
        ) {
          // The turn was refused by the plan limit: pin the root to error (the
          // reducer already did on a real is_error result; this is a no-op then),
          // end the SDK stream, then hand off exactly once. limitReached was set
          // synchronously at the limit signal above, so the upsert below already
          // carries it and the generic error push stays silent.
          session.limitNotified = true;
          for (const event of setStatus(session.tree, 'root', 'error')) this.emit(event);
          const info = { ...session.limitHit };
          session.queue.close();
          this.scheduleUpsert(session);
          try {
            const out = this.hooks?.onLimit?.(session.id, info) as unknown;
            if (out instanceof Promise) out.catch(err => console.error(`Session ${session.id} onLimit failed:`, err));
          } catch (err) {
            console.error(`Session ${session.id} onLimit failed:`, err);
          }
        } else {
          this.scheduleUpsert(session);
        }
      }
      if (generation === session.generation && !session.stopped && !session.limitHit) {
        for (const event of setStatus(session.tree, 'root', 'done')) this.emit(event);
        this.flushUpsert(session);
      } else if (generation === session.generation && !session.stopped && session.limitHit) {
        // The refused turn already pinned the root to error above: just make sure
        // the final summary (with limitReached) is broadcast, never "done".
        this.flushUpsert(session);
      }
    } catch (err) {
      if (generation === session.generation && !session.stopped) {
        console.error(`Session ${session.id} failed:`, err);
        for (const event of setStatus(session.tree, 'root', 'error')) this.emit(event);
        this.flushUpsert(session);
      }
    } finally {
      session.consuming = false;
      if (generation === session.generation) session.query = null;
    }
  }

  private makeCanUseTool(session: PageSession, generation: number): NonNullable<Options['canUseTool']> {
    return async (toolName, input, { signal, toolUseID, title }) => {
      if (generation !== session.generation) {
        // A stale tool request from a replaced query must not surface in the new turn.
        return { behavior: 'deny', message: 'Session restarted' };
      }
      if (signal?.aborted) {
        return { behavior: 'deny', message: 'Aborted' };
      }
      const request: PermissionRequest = {
        id: randomUUID(),
        sessionId: session.id,
        nodeId: ownerOf(session.tree, toolUseID),
        tool: toolName,
        kind: toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool',
        ...(toolUseID ? { toolUseId: toolUseID } : {}),
        input,
        ...(title ? { title } : {}),
        createdAt: Date.now(),
      };
      const entry: PendingPermission = { request, resolve: () => {} };
      const promise = new Promise<PermissionResult>(resolve => {
        entry.resolve = resolve;
      });
      session.pending.set(request.id, entry);

      for (const event of setStatus(session.tree, request.nodeId, 'waiting')) this.emit(event);
      this.emit({ type: 'permission.request', request });
      this.scheduleUpsert(session);

      const onAbort = () => {
        // The SDK's signal beat the user: deny without flipping the node back to running.
        this.denyPending(session, request.id);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.catch(() => {}).finally(() => signal.removeEventListener('abort', onAbort));

      return promise;
    };
  }

  /** Denies one pending permission without setting its node back to 'running' (abort/stop path). */
  private denyPending(session: PageSession, permissionId: string): void {
    const entry = session.pending.get(permissionId);
    if (!entry) return;
    session.pending.delete(permissionId);
    this.emit({ type: 'permission.resolved', sessionId: session.id, id: permissionId, allow: false });
    entry.resolve({ behavior: 'deny', message: 'Denied in SwarmKit' });
  }

  /** Resolves one pending permission; false when the id is unknown (route answers 404). */
  decide(permissionId: string, body: PermissionDecisionBody): boolean {
    const target =
      [...this.sessions.values()].find(s => s.pending.has(permissionId));
    if (!target) return false;
    const entry = target.pending.get(permissionId);
    if (!entry) return false;
    target.pending.delete(permissionId);

    const result: PermissionResult =
      body.allow && body.answers && entry.request.tool === 'AskUserQuestion'
        ? { behavior: 'allow', updatedInput: { ...entry.request.input, answers: body.answers } }
        : body.allow
          ? {
              behavior: 'allow',
              updatedInput: entry.request.input,
              // A plan approval can pick the mode to continue in (applies to this session only);
              // an untrusted project stays on 'default' (its settings files are attacker-controlled),
              // and only a session actually in plan mode takes one.
              ...(body.mode && entry.request.kind === 'plan' && !target.untrustedProject && target.permissionMode === 'plan'
                ? { updatedPermissions: [{ type: 'setMode' as const, mode: body.mode, destination: 'session' as const }] }
                : {}),
            }
          : { behavior: 'deny', message: body.message || 'Denied in SwarmKit' };
    if (result.behavior === 'allow' && result.updatedPermissions && body.mode) target.permissionMode = body.mode;
    this.emit({ type: 'permission.resolved', sessionId: target.id, id: permissionId, allow: body.allow });
    for (const event of setStatus(target.tree, entry.request.nodeId, 'running')) this.emit(event);
    this.scheduleUpsert(target);
    entry.resolve(result);
    return true;
  }

  send(id: string, text: string, images?: ImageAttachment[], files?: FileAttachment[]): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.stopped || !session.consuming || !session.query) {
      throw new SessionError(409, 'Session has ended; use Continue');
    }
    const busy = ['running', 'waiting'].includes(session.tree.nodes.get('root')?.status ?? '');
    const turn = this.prepareTurn(session, text, images, files);
    // opencode (ACP refuses a second prompt mid-turn) and agy (one process per turn) answer after the turn:
    // the user event shows Queued until the adapter takes the message (onTake).
    if (busy && session.runtime !== 'claude') this.markQueued(session, turn);
    // Claude: 'next' steers a running turn at its next tool boundary instead of waiting for the turn to end
    // (never interrupt: that would kill background agents and workers).
    session.queue.push(session.runtime === 'claude' ? { ...turn.message, priority: 'next' } : turn.message);
    for (const event of turn.events) this.emit(event);
    for (const event of setStatus(session.tree, 'root', 'running')) this.emit(event);
    this.scheduleUpsert(session);
    return true;
  }

  /** Flags the turn's user event as queued (the stored event and the one about to be emitted are the same object). */
  private markQueued(session: PageSession, turn: { message: SDKUserMessage; events: ServerEvent[] }): void {
    for (const ev of turn.events) if (ev.type === 'node.event' && ev.event.kind === 'user') ev.event.queued = true;
    if (turn.message.uuid) (session.queuedUuids ??= new Set()).add(turn.message.uuid);
  }

  /** Clears the Queued flag of one queued message (the lead took it) or, without a uuid, of all (stop/unwind). */
  private unqueue(session: PageSession, uuid?: string): void {
    const queued = session.queuedUuids;
    if (!queued || queued.size === 0) return;
    const ids = uuid === undefined ? [...queued] : queued.has(uuid) ? [uuid] : [];
    for (const u of ids) {
      queued.delete(u);
      const event = session.tree.nodes.get('root')?.events.find(e => e.id === `${u}:user`);
      if (!event?.queued) continue;
      delete event.queued;
      this.emit({ type: 'node.event', sessionId: session.id, nodeId: 'root', event: { ...event } });
    }
  }

  interrupt(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.stopped || !session.consuming || !session.query) {
      throw new SessionError(409, 'Session has ended; use Continue');
    }
    const interrupt = (session.query as unknown as { interrupt?: () => Promise<unknown> }).interrupt;
    void interrupt?.call(session.query)?.catch(() => {});
    return true;
  }

  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.stopped && !session.consuming) return true;
    session.stopped = true;
    // The agy permission hook must not outlive the session (restarts re-register).
    if (session.hookSecret) this.bridge.unregister(session.hookSecret);
    // Best-effort interrupt of the current turn, then close the input queue and abort.
    if (session.query) {
      const interrupt = (session.query as unknown as { interrupt?: () => Promise<unknown> }).interrupt;
      void interrupt?.call(session.query)?.catch(() => {});
    }
    session.queue.close();
    this.unqueue(session);  // messages still waiting are dropped with the queue
    session.abort.abort();
    // Anything still pending is denied here (the abort listener handles results
    // flowing through canUseTool's own signal; this is the fallback path).
    for (const { request } of [...session.pending.values()]) {
      this.denyPending(session, request.id);
    }
    // Running subagents and workers end, too; the abort listener above must not put them back to running.
    for (const node of session.tree.nodes.values()) {
      if (node.id !== 'root' && (node.status === 'running' || node.status === 'waiting')) {
        for (const event of setStatus(session.tree, node.id, 'stopped')) this.emit(event);
      }
    }
    for (const event of setStatus(session.tree, 'root', 'stopped')) this.emit(event);
    this.flushUpsert(session);
    return true;
  }

  owns(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Continues a session with a new user message: like start() but with the SDK's `resume`
   * option, the same session id and (for terminal sessions) a tree rebuilt from the prior
   * transcript nodes. Idle-but-live sessions just get the new message; active ones throw
   * SessionError; the terminal-transcript 60 s freshness check never applies to sessions
   * we own (page-owned stop must be continuable at once). A live heartbeat file
   * (~/.claude/sessions/<pid>.json) naming this id refuses the resume for terminal
   * sessions outright and for restarting page sessions when the holder is not one of
   * the dashboard's own SDK processes (see livesessions.ts).
   */
  async resume(id: string, body: ResumeSessionBody, info: ResumeInfo): Promise<string> {
    // The HTTP layer already validated the body; keep one guard so direct callers still get a 400.
    let text: string;
    let model: string | undefined;
    let effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined;
    let images: ImageAttachment[] | undefined;
    let files: FileAttachment[] | undefined;
    try {
      images = validImages(body?.images);
      files = validFiles(body?.files);
      validAttachmentTotals(images, files);
      text = validMessageText(body?.text, images, files);
      model = validResumeModel(body.model);
      effort = validEffort(body.effort);
    } catch (err) {
      throw new SessionError(400, (err as Error).message);
    }
    // Same cwd validation as the start path, plus the agent regex on the stored agent.
    const cwd = await resolveResumeCwd(info?.cwd);
    const existing = this.sessions.get(id);
    const priorRoot = info.nodes?.find(n => n.id === 'root');
    const storedAgent =
      existing?.agent ??
      (priorRoot && priorRoot.agentType !== 'main' ? priorRoot.agentType : undefined);
    if (storedAgent !== undefined && !AGENT_RE.test(storedAgent)) {
      throw new SessionError(400, `agent must match ${String(AGENT_RE)}`);
    }
    if (existing) {
      if (existing.runtime !== 'claude') return this.resumeRuntime(existing, text, model, effort, images, files);
      if (effort === undefined && isOpusModel(model)) effort = 'high';
      const root = existing.tree.nodes.get('root');
      let restartForModel = false;
      if (!existing.stopped && existing.consuming) {
        if (root && (root.status === 'running' || root.status === 'waiting')) {
          throw new SessionError(409, 'Session is still running');
        }
        let modelSwitched = false;
        if (model !== undefined && model !== existing.model) {
          const setModel = (existing.query as unknown as { setModel?: (m?: string) => Promise<void> } | null)?.setModel;
          if (typeof setModel === 'function') {
            try {
              await setModel.call(existing.query, model);
              existing.model = model;
              if (root) {
                root.model = model;
                this.emit(upsertEvent(root));
              }
              modelSwitched = true;
            } catch {
              restartForModel = true;
            }
          } else {
            restartForModel = true;
          }
        }
        if (!restartForModel) {
          // Idle (turn ended, input queue open): the live process just takes the message.
          if (effort !== undefined && effort !== existing.effort) {
            // The live process keeps its start effort unless told: best effort, the turn still runs.
            const applyFlags = (existing.query as unknown as { applyFlagSettings?: (s: { effortLevel: string }) => Promise<void> } | null)?.applyFlagSettings;
            if (typeof applyFlags === 'function') {
              try {
                await applyFlags.call(existing.query, { effortLevel: effort });
              } catch {
                // Older CLI: the stored effort applies from the next restart.
              }
            }
          }
          if (effort !== undefined) existing.effort = effort;
          existing.updatedAt = Date.now();
          const turn = this.prepareTurn(existing, text, images, files);
          existing.queue.push(turn.message);
          for (const event of turn.events) this.emit(event);
          for (const event of setStatus(existing.tree, 'root', 'running')) this.emit(event);
          if (modelSwitched) this.flushUpsert(existing);
          else this.scheduleUpsert(existing);
          return id;
        }
      }
      // Restarting a query left the session open elsewhere: a live heartbeat file for
      // this id from a non-dashboard process (not sdk-cli / sdk-ts) means a terminal
      // claude still holds the transcript, and our new query would fork it.
      const leftover = await liveHolder(id);
      if (leftover && !DASHBOARD_ENTRYPOINTS.has(leftover.entrypoint ?? '')) {
        throw new SessionError(409, holderMessage(leftover.pid));
      }
      if (restartForModel) {
        // Close the live idle query's queue so consume() unwinds immediately before restarting.
        existing.stopped = true;
        existing.queue.close();
      }
      // The old process is gone (or stopping): unwind it before starting the new query.
      await this.unwind(existing);
      if (model !== undefined) {
        existing.model = model;
        if (root) root.model = model;
      }
      if (effort !== undefined) existing.effort = effort;
      this.startQuery(existing, text, model ?? existing.model, effort ?? existing.effort, true, images, files);
      return id;
    }
    // Non-Claude runtimes live only in page memory: a terminal transcript cannot be adopted into one.
    if (model !== undefined && (RUNTIME_MODELS.opencode.includes(model) || RUNTIME_MODELS.agy.includes(model))) {
      throw new SessionError(409, 'Only page sessions can use this model; start a new session instead');
    }
    // A live heartbeat file from any process (terminal or SDK run) forked by adoption
    // is the dangerous case this guard exists for: refuse before anything else moves.
    const holder = await liveHolder(id);
    if (holder) throw new SessionError(409, holderMessage(holder.pid));
    const stillLive =
      info.transcriptMtimeMs !== undefined && Date.now() - info.transcriptMtimeMs < ACTIVE_MS;
    if (stillLive) throw new SessionError(409, 'This session is still active in a terminal');
    if (effort === undefined && isOpusModel(model)) effort = 'high';
    const priorNodes = info.nodes ?? [];
    const title = info.title ?? priorRoot?.description ?? 'Resumed session';
    const tree = this.rebuildTree(id, priorNodes, title);
    const priorModel = priorRoot?.model && priorRoot.model !== '<synthetic>' ? priorRoot.model : undefined;
    const sessionModel = model ?? priorModel;
    if (model) {
      const root = tree.nodes.get('root');
      if (root) root.model = model;
    }
    const session: PageSession = {
      id,
      cwd,
      ...(storedAgent ? { agent: storedAgent } : {}),
      ...(sessionModel ? { model: sessionModel } : {}),
      ...(effort ? { effort } : {}),
      // Terminal adoptions are always Claude Code sessions (non-Claude models refuse above).
      runtime: 'claude',
      title: firstPromptLine(title),
      startedAt: priorRoot?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      tree,
      queue: new InputQueue(),
      abort: new AbortController(),
      query: null,
      pending: new Map(),
      stopped: false,
      consuming: false,
      generation: 0,
      consumePromise: null,
      untrustedProject: false,
      upsertThrottle: { lastSent: 0, timer: null },
    };
    this.sessions.set(id, session);
    this.startQuery(session, text, session.model, effort, true, images, files);
    return id;
  }

  /**
   * Continues a page-owned non-Claude session in memory: the tree stays as-is
   * (no Claude transcript rebuild), the new query resumes the adapter's own
   * conversation id. Idle-but-live sessions just take the message; active ones
   * refuse with 409; ended ones restart the adapter query.
   */
  private async resumeRuntime(session: PageSession, text: string, model: string | undefined, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined, images?: ImageAttachment[], files?: FileAttachment[]): Promise<string> {
    const root = session.tree.nodes.get('root');
    if (!session.stopped && session.consuming) {
      if (root && (root.status === 'running' || root.status === 'waiting')) {
        throw new SessionError(409, 'Session is still running');
      }
      if (effort !== undefined) session.effort = effort;
      if (model !== undefined) session.model = model;
      session.updatedAt = Date.now();
      const turn = this.prepareTurn(session, text, images, files);
      session.queue.push(turn.message);
      for (const event of turn.events) this.emit(event);
      for (const event of setStatus(session.tree, 'root', 'running')) this.emit(event);
      this.scheduleUpsert(session);
      return session.id;
    }
    // Restarting a query left the session open elsewhere: a live heartbeat file for
    // this id from a non-dashboard process refuses the restart with the same 409.
    const leftover = await liveHolder(session.id);
    if (leftover && !DASHBOARD_ENTRYPOINTS.has(leftover.entrypoint ?? '')) {
      throw new SessionError(409, holderMessage(leftover.pid));
    }
    // The old process is gone (or stopping): unwind it before starting the new query.
    await this.unwind(session);
    if (model !== undefined) session.model = model;
    if (effort !== undefined) session.effort = effort;
    this.startQuery(session, text, model ?? session.model, effort, true, images, files);
    return session.id;
  }

  /** Unwinds a stopped/stopping query before a resumed/restarted one starts. */
  private async unwind(session: PageSession): Promise<void> {
    session.abort.abort();
    await Promise.race([
      session.consumePromise ?? Promise.resolve(),
      new Promise<void>(resolve => setTimeout(resolve, RESUME_UNWIND_MS).unref()),
    ]);
    session.stopped = false;
    // Continuing after a plan-limit hit: the new turn decides the status again. limitNotified
    // stays set, so one session never starts a second fallback lead.
    session.limitHit = undefined;
    session.limitReached = undefined;
    session.pending.clear();
    this.unqueue(session);
    session.queue = new InputQueue();
    session.upsertThrottle = { lastSent: 0, timer: null };
    session.updatedAt = Date.now();
  }

  /**
   * Restarts the SDK process of a page-owned Claude session on the same id
   * (picks up newly installed agents): a live process is stopped first, the old
   * query is unwound, and a resumed query starts with the session's stored
   * cwd/agent/effort/model. Without text no user turn is prepared and the root
   * stays idle; with text it behaves like a resume.
   */
  async restart(id: string, body: { text?: string }): Promise<string> {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(404, 'session not found');
    if (session.runtime !== 'claude') throw new SessionError(400, 'Restart is only for Claude sessions');
    // Empty/absent text means "no text"; given text must read like a resume message.
    let text: string | undefined;
    const raw = body?.text;
    if (typeof raw === 'string' && raw.trim().length === 0) {
      text = undefined;
    } else if (raw !== undefined && raw !== null) {
      try {
        text = validMessageText(raw, undefined);
      } catch (err) {
        throw new SessionError(400, (err as Error).message);
      }
    }
    // Same fork-protection as resume: a live non-dashboard holder refuses the restart.
    const leftover = await liveHolder(id);
    if (leftover && !DASHBOARD_ENTRYPOINTS.has(leftover.entrypoint ?? '')) {
      throw new SessionError(409, holderMessage(leftover.pid));
    }
    if (!session.stopped) this.stop(id);
    await this.unwind(session);
    this.startQuery(session, text, session.model, session.effort, true);
    return id;
  }

  /** Rebuilds a SessionTree from transcript nodes: statuses become terminal states, the root restarts. */
  private rebuildTree(id: string, priorNodes: AgentNode[], title: string | undefined): SessionTree {
    const priorRoot = priorNodes.find(n => n.id === 'root');
    const prompt = priorRoot?.prompt ?? (firstPromptLine(title ?? '') || undefined);
    const tree = createTree(id, {
      startedAt: priorRoot?.startedAt ?? Date.now(),
      agentType: priorRoot?.agentType ?? 'main',
      ...(prompt ? { prompt } : {}),
    });
    const root = tree.nodes.get('root')!;
    if (priorRoot) {
      root.prompt = priorRoot.prompt;
      if (priorRoot.description) root.description = priorRoot.description;
      else if (title) root.description = firstPromptLine(title);
      if (priorRoot.model && priorRoot.model !== '<synthetic>') root.model = priorRoot.model;
      root.result = priorRoot.result;
      root.lastActivity = priorRoot.lastActivity;
      root.costUsd = priorRoot.costUsd;
      root.tokens = { ...priorRoot.tokens };
      root.toolCounts = { ...priorRoot.toolCounts };
      root.events = [...priorRoot.events];
    }
    for (const node of priorNodes) {
      if (node.id === 'root') continue;
      tree.nodes.set(node.id, { ...node, sessionId: id, events: node.events.slice(-MAX_EVENTS) });
    }
    // Rebuild the tool_use_id ownership map from the kept events.
    for (const node of tree.nodes.values()) {
      for (const event of node.events) {
        if (event.toolUseId && !tree.toolOwner.has(event.toolUseId)) {
          tree.toolOwner.set(event.toolUseId, node.id);
        }
      }
    }
    root.status = 'running';
    root.endedAt = undefined;
    return tree;
  }

  /** The tree node that started a worker with this lane+slug, when any page session has one. */
  findWorkerNode(lane: 'agy' | 'opencode', slug: string): { sessionId: string; nodeId: string } | undefined {
    for (const session of this.sessions.values()) {
      for (const node of session.tree.nodes.values()) {
        if (node.kind === 'worker' && node.worker?.lane === lane && node.worker?.slug === slug) {
          return { sessionId: session.id, nodeId: node.id };
        }
      }
    }
    return undefined;
  }

  /** cwd (and no transcript mtime: page sessions do not own one) of a page session. */
  fileInfo(id: string): { cwd: string } | undefined {
    const session = this.sessions.get(id);
    return session ? { cwd: session.cwd } : undefined;
  }

  /** Raw paths the session's write tool calls named (Write/Edit/MultiEdit/NotebookEdit). */
  writtenPaths(id: string): string[] | undefined {
    const session = this.sessions.get(id);
    return session ? [...(session.tree.writtenPaths ?? [])] : undefined;
  }

  /** Lead runtime of a page session, if we own the id. */
  runtimeOf(id: string): Runtime | undefined {
    return this.sessions.get(id)?.runtime;
  }

  /** Last live command list per runtime + cwd, served while no query of that kind is live. */
  private commandCache: CommandCache;

  /** The last live command list seen for this runtime and cwd, else for the runtime anywhere ([] when none yet). */
  cachedCommands(runtime: Runtime, cwd: string): SlashCommandInfo[] {
    return this.commandCache.get(runtime, cwd);
  }

  /**
   * Slash commands of a page session; undefined when the id isn't ours. A live query is
   * asked directly; otherwise agy rescans disk and the others get the cached list.
   */
  async commands(id: string): Promise<SlashCommandInfo[] | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (!session.query) {
      return session.runtime === 'agy' ? listAgyCommands(session.cwd) : this.cachedCommands(session.runtime, session.cwd);
    }
    const live = await this.liveCommands(session);
    if (live.length > 0) this.commandCache.set(session.runtime, session.cwd, live);
    return live.length > 0 ? live : this.cachedCommands(session.runtime, session.cwd);
  }

  /**
   * Fills an empty command cache from a promptless Claude query: the CLI answers
   * supportedCommands without a turn (no tokens), then it is aborted. No init arrives, so
   * terminal-only commands are not filtered out; the first page session's list replaces it.
   */
  async primeCommands(cwd: string): Promise<void> {
    if (this.commandCache.get('claude', cwd).length > 0) return;
    const abort = new AbortController();
    const queue = new InputQueue();
    const q = this.queryFn({
      prompt: queue,
      options: { cwd, abortController: abort, settingSources: isProjectTrusted(cwd) ? ['user', 'project', 'local'] : ['user'], permissionMode: 'default' },
    });
    // Drain the stream so the SDK's reader never blocks; it ends when aborted.
    void (async () => {
      try {
        for await (const _ of q) void _;
      } catch {
        // aborted
      }
    })();
    try {
      const live = await this.liveCommands({ query: q } as unknown as PageSession);
      if (live.length > 0 && !this.commandCache.has('claude', cwd)) this.commandCache.set('claude', cwd, live);
    } finally {
      queue.close();
      abort.abort();
    }
  }

  private async liveCommands(session: PageSession): Promise<SlashCommandInfo[]> {
    const fn = (session.query as unknown as { supportedCommands?: () => Promise<unknown> }).supportedCommands;
    if (!fn) return [];
    let timer: NodeJS.Timeout | null = null;
    let raw: unknown;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('commands timed out')), 5000);
      });
      raw = await Promise.race([fn.call(session.query), timeout]);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: SlashCommandInfo[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as { name?: unknown; description?: unknown; argumentHint?: unknown };
      if (typeof r.name !== 'string' || r.name.length === 0) continue;
      let name = r.name;
      if (name.startsWith('/')) name = name.slice(1);
      // '__'-prefixed names are the CLI's internal commands.
      if (name.length === 0 || name.startsWith('__')) continue;
      if (session.terminalCommands?.has(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const cmd: SlashCommandInfo = { name };
      if (typeof r.description === 'string' && r.description.length > 0) cmd.description = r.description;
      if (typeof r.argumentHint === 'string' && r.argumentHint.length > 0) cmd.argumentHint = r.argumentHint;
      out.push(cmd);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Answers the agy plugin permission hook for a session: deny (403) unless the
   * id names a page session with the agy runtime whose hook secret matches
   * (constant-time); otherwise the bridge maps the tool call and runs it through
   * the session's permission flow.
   */
  handleAgyHook(id: string, secret: string | undefined, body: unknown, signal?: AbortSignal): Promise<AgyHookResponse> {
    const deny = (reason: string): Promise<AgyHookResponse> => Promise.resolve({ status: 403, json: { decision: 'deny', reason } });
    const session = this.sessions.get(id);
    if (!session || session.runtime !== 'agy' || !session.hookSecret) {
      return deny('unknown session');
    }
    const given = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : null;
    const expected = Buffer.from(session.hookSecret, 'utf8');
    if (!given || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return deny('unknown hook secret');
    }
    return this.bridge.handle(secret, body, signal);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map(s => this.summarize(s));
  }

  get(id: string): SessionDetail | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {
      ...this.summarize(session),
      nodes: [...session.tree.nodes.values()].map(node => ({ ...node, events: [...node.events] })),
      permissions: [...session.pending.values()].map(p => p.request),
    };
  }

  cwds(): string[] {
    const out: string[] = [];
    for (const session of this.sessions.values()) {
      if (!out.includes(session.cwd)) out.push(session.cwd);
    }
    return out;
  }

  private summarize(session: PageSession): SessionSummary {
    const root = session.tree.nodes.get('root');
    const status = root?.status ?? 'idle';
    const ended = status === 'done' || status === 'error' || status === 'stopped';
    return {
      id: session.id,
      source: 'page',
      project: path.basename(session.cwd),
      cwd: session.cwd,
      title: session.title,
      status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      costUsd: root?.costUsd ?? 0,
      ...(session.agent ? { agent: session.agent } : {}),
      ...((root?.model ?? session.model) ? { model: root?.model ?? session.model } : {}),
      ...(session.triage ? { triage: { ...session.triage } } : {}),
      nodeCount: session.tree.nodes.size,
      pendingPermissions: session.pending.size,
      runtime: session.runtime,
      // Non-Claude sessions have no transcript: resumable while ended with a known runtime session id.
      resumable: session.runtime === 'claude'
        ? pageResumable(session.id, session.cwd, status)
        : ended && session.runtimeSessionId !== undefined,
      ...(session.untrustedProject ? { untrustedProject: true } : {}),
      ...(session.fallbackOf ? { fallbackOf: { ...session.fallbackOf } } : {}),
      ...(session.limitReached
        ? {
            limitReached: {
              window: session.limitReached.window,
              resetsAt: session.limitReached.resetsAt,
              fallback: session.limitReached.fallback
                ? { ...session.limitReached.fallback }
                : null,
            },
          }
        : {}),
    };
  }

  /** At most one session.upsert per UPSERT_MS per session. */
  private scheduleUpsert(session: PageSession): void {
    session.updatedAt = Date.now();
    const since = session.updatedAt - session.upsertThrottle.lastSent;
    const send = () => {
      session.upsertThrottle.lastSent = Date.now();
      this.emit({ type: 'session.upsert', session: this.summarize(session) });
    };
    if (since >= UPSERT_MS) {
      send();
      return;
    }
    if (session.upsertThrottle.timer) return;
    session.upsertThrottle.timer = setTimeout(() => {
      session.upsertThrottle.timer = null;
      send();
    }, UPSERT_MS - since);
    session.upsertThrottle.timer.unref();
  }

  /** Always sends one final session.upsert (after done/error/stopped). */
  private flushUpsert(session: PageSession): void {
    if (session.upsertThrottle.timer) {
      clearTimeout(session.upsertThrottle.timer);
      session.upsertThrottle.timer = null;
    }
    session.updatedAt = Date.now();
    this.emit({ type: 'session.upsert', session: this.summarize(session) });
  }

  /**
   * Every few seconds: evict old finished sessions, then refresh worker nodes.
   * A session is polled when its root is running OR any node is a running worker,
   * regardless of the query state, at most one poll in flight per session.
   */
  /** Deletes image stores of long-gone sessions (at most hourly; at start and from poll). */
  private pruneImages(): void {
    const now = Date.now();
    if (now - this.lastImagePrune < 3_600_000) return;
    this.lastImagePrune = now;
    pruneOrphanImages(id => this.sessions.has(id), 7 * 86_400_000, now);
    // Artifact files stay downloadable after eviction: prune only stores no page session owns.
    pruneOrphanArtifacts(id => this.sessions.has(id), 30 * 86_400_000, now);
  }

  private poll(): void {
    this.evict();
    this.pruneImages();
    for (const session of this.sessions.values()) {
      if (this.polling.has(session.id)) continue;
      const root = session.tree.nodes.get('root');
      const hasRunningWorker = [...session.tree.nodes.values()]
        .some(node => node.kind === 'worker' && node.status === 'running');
      if (!root || (root.status !== 'running' && !hasRunningWorker)) continue;
      this.polling.add(session.id);
      void pollWorkers(session.tree)
        .then(events => {
          for (const event of events) this.emit(event);
        })
        .catch(err => console.error(`Worker poll failed for session ${session.id}:`, err))
        .finally(() => this.polling.delete(session.id));
    }
  }

  /**
   * Removes finished (stopped/done/error/stopped root) sessions that were idle for
   * longer than `olderThanMs`, then the oldest finished ones beyond `maxSessions`.
   * Removed transcripts re-appear as terminal sessions through the watcher.
   */
  evict(
    now: number = Date.now(),
    olderThanMs: number = EVICT_AFTER_MS,
    maxSessions: number = MAX_PAGE_SESSIONS,
  ): void {
    const finished = (session: PageSession): boolean => {
      if (session.consuming) return false;
      if (session.stopped) return true;
      const status = session.tree.nodes.get('root')?.status;
      return status === 'done' || status === 'error' || status === 'stopped';
    };
    for (const [id, session] of this.sessions) {
      if (finished(session) && now - session.updatedAt > olderThanMs) {
        if (session.hookSecret) this.bridge.unregister(session.hookSecret);
        this.sessions.delete(id);
        deleteImages(id);
        this.emit({ type: 'session.removed', sessionId: id });
      }
    }
    const oldest = [...this.sessions.values()].filter(finished).sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.sessions.size > maxSessions && oldest.length > 0) {
      const victim = oldest.shift()!;
      if (victim.hookSecret) this.bridge.unregister(victim.hookSecret);
      if (!this.sessions.delete(victim.id)) continue;
      deleteImages(victim.id);
      this.emit({ type: 'session.removed', sessionId: victim.id });
    }
  }
}
