// Page sessions driven by the Claude Agent SDK: one query per browser-started session,
// permission prompts resolved from the dashboard, a live agent tree per session.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { applyMessage, createTree, ownerOf, setStatus } from '../model/reducer.ts';
import type { SessionTree } from '../model/reducer.ts';
import { pollWorkers } from '../model/workers.ts';
import type { PermissionDecisionBody, PermissionRequest, ServerEvent, SessionDetail, SessionSummary, StartSessionBody } from '../../src/shared/types.ts';

/** Throttle for session.upsert broadcasts: at most one per this many ms per session. */
const UPSERT_MS = 250;
/** Interval for polling worker result files of running sessions. */
const POLL_MS = 3_000;

/** Injectable so tests can drive a fake query. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

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
    const queue = new InputQueue();
    const abort = new AbortController();
    const session: PageSession = {
      id,
      cwd: body.cwd,
      ...(body.agent ? { agent: body.agent } : {}),
      title: firstPromptLine(body.prompt),
      startedAt,
      updatedAt: startedAt,
      tree,
      queue,
      abort,
      query: null,
      pending: new Map(),
      stopped: false,
      upsertThrottle: { lastSent: 0, timer: null },
    };
    this.sessions.set(id, session);

    const options: Options = {
      cwd: session.cwd,
      sessionId: id,
      abortController: abort,
      settingSources: ['user', 'project', 'local'],
      forwardSubagentText: true,
      permissionMode: 'default',
      canUseTool: this.makeCanUseTool(session),
      ...(session.agent ? { agent: session.agent } : {}),
      ...(body.model ? { model: body.model } : {}),
    };
    session.query = this.queryFn({ prompt: queue, options });
    queue.push({
      type: 'user',
      message: { role: 'user', content: body.prompt },
      parent_tool_use_id: null,
      session_id: id,
    });
    void this.consume(session);
    this.scheduleUpsert(session);
    return id;
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
