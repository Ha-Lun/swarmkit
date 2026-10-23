// Page sessions driven by the Claude Agent SDK: one query per browser-started session,
// permission prompts resolved from the dashboard, a live agent tree per session.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyMessage, createTree, ownerOf, setStatus } from '../model/reducer.ts';
import type { SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';
import { MAX_EVENTS } from '../../src/shared/types.ts';
import type { AgentNode, PermissionDecisionBody, PermissionRequest, ResumeSessionBody, ServerEvent, SessionDetail, SessionSummary, StartSessionBody } from '../../src/shared/types.ts';

/** Throttle for session.upsert broadcasts: at most one per this many ms per session. */
const UPSERT_MS = 250;
/** Interval for polling worker result files of running sessions. */
const POLL_MS = 3_000;
/** Max characters of a resume prompt. */
const MAX_TEXT = 100_000;
/** A transcript written within this window means a terminal session is still live. */
const ACTIVE_MS = 60_000;
const MODEL_RE = /^(opus|sonnet|haiku|claude-[a-z0-9.-]{1,60})$/;

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
  upsertThrottle: { lastSent: number; timer: NodeJS.Timeout | null };
}

const firstPromptLine = (prompt: string): string => {
  const line = prompt.split('\n', 1)[0] ?? prompt;
  return line.length > 120 ? line.slice(0, 120) : line;
};

export class SdkSessions {
  private sessions = new Map<string, PageSession>();
  private pollTimer: NodeJS.Timeout;

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
      upsertThrottle: { lastSent: 0, timer: null },
    };
    this.sessions.set(id, session);

    this.startQuery(session, body.prompt, body.model, false);
    return id;
  }

  /** Runs the SDK query for a session (fresh start or resumed continuation) and consumes it in the background. */
  private startQuery(session: PageSession, prompt: string, model: string | undefined, resume: boolean): void {
    session.abort = new AbortController();
    const options: Options = {
      cwd: session.cwd,
      abortController: session.abort,
      settingSources: ['user', 'project', 'local'],
      forwardSubagentText: true,
      permissionMode: 'default',
      canUseTool: this.makeCanUseTool(session),
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
    void this.consume(session);
    if (resume) {
      for (const event of setStatus(session.tree, 'root', 'running')) this.emit(event);
    }
    this.scheduleUpsert(session);
  }

  /** Consumes the SDK iterator and broadcasts tree events + throttled summaries. */
  private async consume(session: PageSession): Promise<void> {
    try {
      for await (const message of session.query as AsyncIterable<SDKMessage>) {
        for (const event of applyMessage(session.tree, message)) this.emit(event);
        this.scheduleUpsert(session);
      }
      if (!session.stopped) for (const event of setStatus(session.tree, 'root', 'done')) this.emit(event);
      this.flushUpsert(session);
    } catch (err) {
      if (!session.stopped) {
        console.error(`Session ${session.id} failed:`, err);
        for (const event of setStatus(session.tree, 'root', 'error')) this.emit(event);
      }
      this.flushUpsert(session);
    }
  }

  private makeCanUseTool(session: PageSession): Options['canUseTool'] {
    return async (toolName, input, { signal, toolUseID, title }) => {
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
        // The SDK's signal beat the user: deny and tell the dashboard.
        this.decide(request.id, { allow: false }, session);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.catch(() => {}).finally(() => signal.removeEventListener('abort', onAbort));

      return promise;
    };
  }

  /** Resolves one pending permission; false when the id is unknown (route answers 404). */
  decide(permissionId: string, body: PermissionDecisionBody, session?: PageSession): boolean {
    const target =
      session ??
      [...this.sessions.values()].find(s => s.pending.has(permissionId));
    if (!target) return false;
    const entry = target.pending.get(permissionId);
    if (!entry) return false;
    target.pending.delete(permissionId);

    const result: PermissionResult = body.allow
      ? { behavior: 'allow', updatedInput: entry.request.input }
      : { behavior: 'deny', message: body.message || 'Denied in Claude Fleet' };
    this.emit({ type: 'permission.resolved', sessionId: target.id, id: permissionId, allow: body.allow });
    for (const event of setStatus(target.tree, entry.request.nodeId, 'running')) this.emit(event);
    this.scheduleUpsert(target);
    entry.resolve(result);
    return true;
  }

  send(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.stopped) return false;
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
    if (!session || !session.query) return false;
    const interrupt = (session.query as unknown as { interrupt?: () => Promise<unknown> }).interrupt;
    void interrupt?.call(session.query)?.catch(() => {});
    return true;
  }

  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.stopped) return true;
    session.stopped = true;
    this.interrupt(id);
    session.queue.close();
    session.abort.abort();
    // Anything still pending is denied here (the abort listener handles results
    // flowing through canUseTool's own signal; this is the fallback path).
    for (const { request } of [...session.pending.values()]) {
      this.decide(request.id, { allow: false }, session);
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
   * transcript nodes. Ends sessions can always resume; active ones throw SessionError.
   */
  resume(id: string, body: ResumeSessionBody, info: ResumeInfo): string {
    const text = body?.text;
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT) {
      throw new SessionError(400, 'text must be a non-empty string of at most 100000 characters');
    }
    if (body.model !== undefined && body.model !== null &&
        (typeof body.model !== 'string' || !MODEL_RE.test(body.model))) {
      throw new SessionError(400, "model must be 'opus', 'sonnet', 'haiku' or a 'claude-*' model id");
    }
    const stillLive =
      info.transcriptMtimeMs !== undefined && Date.now() - info.transcriptMtimeMs < ACTIVE_MS;
    const existing = this.sessions.get(id);
    if (existing) {
      const root = existing.tree.nodes.get('root');
      if (root && (root.status === 'running' || root.status === 'waiting')) {
        throw new SessionError(409, 'Session is still running');
      }
      if (stillLive) throw new SessionError(409, 'This session is still active in a terminal');
      existing.queue = new InputQueue();
      existing.upsertThrottle = { lastSent: 0, timer: null };
      existing.updatedAt = Date.now();
      this.startQuery(existing, text, body.model, true);
      return id;
    }
    if (stillLive) throw new SessionError(409, 'This session is still active in a terminal');
    if (typeof info?.cwd !== 'string' || info.cwd.length === 0) {
      throw new SessionError(400, 'cwd is required');
    }
    const priorNodes = info.nodes ?? [];
    const priorRoot = priorNodes.find(n => n.id === 'root');
    const title = info.title ?? priorRoot?.description ?? 'Resumed session';
    const tree = this.rebuildTree(id, priorNodes, title);
    const session: PageSession = {
      id,
      cwd: info.cwd,
      ...(priorRoot && priorRoot.agentType !== 'main' ? { agent: priorRoot.agentType } : {}),
      title: firstPromptLine(title),
      startedAt: priorRoot?.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      tree,
      queue: new InputQueue(),
      abort: new AbortController(),
      query: null,
      pending: new Map(),
      stopped: false,
      upsertThrottle: { lastSent: 0, timer: null },
    };
    this.sessions.set(id, session);
    this.startQuery(session, text, body.model, true);
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
  fileInfo(id: string): { cwd: string; mtimeMs?: number } | undefined {
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

  /** Every few seconds, refresh worker nodes of sessions whose root is still running. */
  private poll(): void {
    for (const session of this.sessions.values()) {
      const root = session.tree.nodes.get('root');
      if (!session.query || !root || root.status !== 'running') continue;
      void pollWorkers(session.tree)
        .then(events => {
          for (const event of events) this.emit(event);
        })
        .catch(err => console.error(`Worker poll failed for session ${session.id}:`, err));
    }
  }
}
