// Page sessions driven by the Claude Agent SDK: one query per browser-started session,
// permission prompts resolved from the dashboard, a live agent tree per session.
import { randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult, SDKMessage, SDKRateLimitEvent, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyMessage, createTree, ownerOf, setStatus } from '../model/reducer.ts';
import type { SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';
import { noteRateLimit } from '../usage.ts';
import { DASHBOARD_ENTRYPOINTS, holderMessage, liveHolder } from '../livesessions.ts';
import { MAX_EVENTS } from '../../src/shared/types.ts';
import type { AgentNode, PermissionDecisionBody, PermissionRequest, ResumeSessionBody, ServerEvent, SessionDetail, SessionSummary, StartSessionBody } from '../../src/shared/types.ts';
import { AGENT_RE, validModel, validText } from '../validate.ts';
import { resolveDirInHome } from '../paths.ts';

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

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
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
        if (item) return Promise.resolve({ value: item, done: false });
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
  /** First line of the first prompt, clamped to 120 chars for the title. */
  title: string;
  startedAt: number;
  updatedAt: number;
  tree: SessionTree;
  queue: InputQueue;
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
  upsertThrottle: { lastSent: number; timer: NodeJS.Timeout | null };
}

const firstPromptLine = (prompt: string): string => {
  const line = prompt.split('\n', 1)[0] ?? prompt;
  return line.length > 120 ? line.slice(0, 120) : line;
};

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

/** Same cwd contract as the start path (index.ts resolveCwd): must exist, be a directory, inside $HOME. */
async function resolveResumeCwd(raw: string | undefined): Promise<string> {
  const resolved = await resolveDirInHome(raw);
  if ('error' in resolved) throw new SessionError(400, resolved.error);
  return resolved.dir;
}

export class SdkSessions {
  private sessions = new Map<string, PageSession>();
  private pollTimer: NodeJS.Timeout;
  /** Session ids with a pollWorkers call in flight (one poll at a time per session). */
  private polling = new Set<string>();

  constructor(
    private emit: (e: ServerEvent) => void,
    private queryFn: QueryFn = query,
  ) {
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    this.pollTimer.unref();
  }

  /** Starts a session in the background and returns its id at once. */
  start(body: StartSessionBody): string {
    const id = randomUUID();
    const startedAt = Date.now();
    const tree = createTree(id, { startedAt, agentType: body.agent || 'main', prompt: body.prompt });
    const session: PageSession = {
      id,
      cwd: body.cwd,
      ...(body.agent ? { agent: body.agent } : {}),
      title: firstPromptLine(body.prompt),
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

    this.startQuery(session, body.prompt, body.model, false);
    return id;
  }

  /** Runs the SDK query for a session (fresh start or resumed continuation) and consumes it in the background. */
  private startQuery(session: PageSession, prompt: string, model: string | undefined, resume: boolean): void {
    session.generation += 1;
    const generation = session.generation;
    session.abort = new AbortController();
    // Untrusted projects only get user settings: project/local settings files would be attacker-controlled.
    session.untrustedProject = !isProjectTrusted(session.cwd);
    const options: Options = {
      cwd: session.cwd,
      abortController: session.abort,
      settingSources: session.untrustedProject ? ['user'] : ['user', 'project', 'local'],
      forwardSubagentText: true,
      permissionMode: 'default',
      canUseTool: this.makeCanUseTool(session, generation),
      // A resumed session keeps its id and drops the fixed sessionId (the SDK continues the old one).
      ...(resume ? { resume: session.id } : { sessionId: session.id }),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(model ? { model } : {}),
    };
    session.query = this.queryFn({ prompt: session.queue, options });
    session.queue.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: session.id,
    });
    session.consumePromise = this.consume(session, generation).catch(err => {
      console.error(`Session ${session.id} consume crashed:`, err);
    });
    if (resume) {
      for (const event of setStatus(session.tree, 'root', 'running')) this.emit(event);
    }
    this.scheduleUpsert(session);
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
        }
        for (const event of applyMessage(session.tree, message)) this.emit(event);
        this.scheduleUpsert(session);
      }
      if (generation === session.generation && !session.stopped) {
        for (const event of setStatus(session.tree, 'root', 'done')) this.emit(event);
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

  private makeCanUseTool(session: PageSession, generation: number): Options['canUseTool'] {
    return async (toolName, input, { signal, toolUseID, title }) => {
      if (generation !== session.generation) {
        // A stale tool request from a replaced query must not surface in the new turn.
        return { behavior: 'deny', message: 'Session restarted' };
      }
      const request: PermissionRequest = {
        id: randomUUID(),
        sessionId: session.id,
        nodeId: ownerOf(session.tree, toolUseID),
        tool: toolName,
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

    const result: PermissionResult = body.allow
      ? { behavior: 'allow', updatedInput: entry.request.input }
      : { behavior: 'deny', message: body.message || 'Denied in SwarmKit' };
    this.emit({ type: 'permission.resolved', sessionId: target.id, id: permissionId, allow: body.allow });
    for (const event of setStatus(target.tree, entry.request.nodeId, 'running')) this.emit(event);
    this.scheduleUpsert(target);
    entry.resolve(result);
    return true;
  }

  send(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.stopped || !session.consuming || !session.query) {
      throw new SessionError(409, 'Session has ended; use Continue');
    }
    session.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: id,
    });
    for (const event of setStatus(session.tree, 'root', 'running')) this.emit(event);
    this.scheduleUpsert(session);
    return true;
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
    // Best-effort interrupt of the current turn, then close the input queue and abort.
    if (session.query) {
      const interrupt = (session.query as unknown as { interrupt?: () => Promise<unknown> }).interrupt;
      void interrupt?.call(session.query)?.catch(() => {});
    }
    session.queue.close();
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
    try {
      text = validText(body?.text);
      model = validModel(body.model);
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
      const root = existing.tree.nodes.get('root');
      if (!existing.stopped && existing.consuming) {
        if (root && (root.status === 'running' || root.status === 'waiting')) {
          throw new SessionError(409, 'Session is still running');
        }
        // Idle (turn ended, input queue open): the live process just takes the message.
        existing.updatedAt = Date.now();
        existing.queue.push({
          type: 'user',
          message: { role: 'user', content: text },
          parent_tool_use_id: null,
          session_id: id,
        });
        for (const event of setStatus(existing.tree, 'root', 'running')) this.emit(event);
        this.scheduleUpsert(existing);
        return id;
      }
      // Restarting a query left the session open elsewhere: a live heartbeat file for
      // this id from a non-dashboard process (not sdk-cli / sdk-ts) means a terminal
      // claude still holds the transcript, and our new query would fork it.
      const leftover = await liveHolder(id);
      if (leftover && !DASHBOARD_ENTRYPOINTS.has(leftover.entrypoint ?? '')) {
        throw new SessionError(409, holderMessage(leftover.pid));
      }
      // The old process is gone (or stopping): unwind it before starting the new query.
      existing.abort.abort();
      await Promise.race([
        existing.consumePromise ?? Promise.resolve(),
        new Promise<void>(resolve => setTimeout(resolve, RESUME_UNWIND_MS).unref()),
      ]);
      existing.stopped = false;
      existing.pending.clear();
      existing.queue = new InputQueue();
      existing.upsertThrottle = { lastSent: 0, timer: null };
      existing.updatedAt = Date.now();
      this.startQuery(existing, text, model, true);
      return id;
    }
    // A live heartbeat file from any process (terminal or SDK run) forked by adoption
    // is the dangerous case this guard exists for: refuse before anything else moves.
    const holder = await liveHolder(id);
    if (holder) throw new SessionError(409, holderMessage(holder.pid));
    const stillLive =
      info.transcriptMtimeMs !== undefined && Date.now() - info.transcriptMtimeMs < ACTIVE_MS;
    if (stillLive) throw new SessionError(409, 'This session is still active in a terminal');
    const priorNodes = info.nodes ?? [];
    const title = info.title ?? priorRoot?.description ?? 'Resumed session';
    const tree = this.rebuildTree(id, priorNodes, title);
    const session: PageSession = {
      id,
      cwd,
      ...(storedAgent ? { agent: storedAgent } : {}),
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
    this.startQuery(session, text, model, true);
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
      if (priorRoot.model) root.model = priorRoot.model;
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
    return {
      id: session.id,
      source: 'page',
      project: path.basename(session.cwd),
      cwd: session.cwd,
      title: session.title,
      status: root?.status ?? 'idle',
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      costUsd: root?.costUsd ?? 0,
      ...(session.agent ? { agent: session.agent } : {}),
      ...(root?.model ? { model: root.model } : {}),
      nodeCount: session.tree.nodes.size,
      pendingPermissions: session.pending.size,
      ...(session.untrustedProject ? { untrustedProject: true } : {}),
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
  private poll(): void {
    this.evict();
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
        this.sessions.delete(id);
        this.emit({ type: 'session.removed', sessionId: id });
      }
    }
    const oldest = [...this.sessions.values()].filter(finished).sort((a, b) => a.updatedAt - b.updatedAt);
    while (this.sessions.size > maxSessions && oldest.length > 0) {
      const victim = oldest.shift()!;
      if (!this.sessions.delete(victim.id)) continue;
      this.emit({ type: 'session.removed', sessionId: victim.id });
    }
  }
}
