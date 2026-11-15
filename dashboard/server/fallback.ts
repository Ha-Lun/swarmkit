// Fallback: when a Claude page session hits its plan limit, a free lane (agy or
// opencode) takes over with a handoff prompt. Pure logic; index.ts wires it up.
import type {
  ActivityEvent,
  AgentNode,
  LimitReached,
  Runtime,
  RuntimesResponse,
  UsageReport,
} from '../src/shared/types.ts';

/** Lanes a fallback lead can run on. */
export type FallbackLane = 'agy' | 'opencode';

type LaneReport = Pick<UsageReport, 'agy' | 'opencode'>;

/**
 * Picks the lane for a fallback lead. agy first (all its Gemini limits known and
 * below 95), then opencode (limits present, no error, none limited, all below 95).
 * Missing data means "not usable".
 */
export function pickLane(report: LaneReport, runtimes: RuntimesResponse): FallbackLane | null {
  const agyLimits = report.agy?.limits;
  if (runtimes.agy && Array.isArray(agyLimits)) {
    const gemini = agyLimits.filter(l => l.group === 'Gemini');
    if (
      gemini.length > 0 &&
      gemini.every(l => typeof l.utilization === 'number' && l.utilization < 95)
    ) {
      return 'agy';
    }
  }
  const opencode = report.opencode;
  if (
    runtimes.opencode &&
    Array.isArray(opencode?.limits) &&
    opencode.limits.length > 0 &&
    !opencode.limitsError &&
    opencode.limits.every(l => !l.limited && typeof l.utilization === 'number' && l.utilization < 95)
  ) {
    return 'opencode';
  }
  return null;
}

/** What buildHandoff needs of the old session (SessionDetail plus permission mode). */
export interface HandoffSession {
  id: string;
  title: string;
  cwd: string;
  permissionMode?: string;
  nodes: AgentNode[];
}

export interface LimitInfo {
  window: string;
  resetsAt: string | null;
}

/** Assistant texts kept from the tail of the session. */
const MAX_HANDOFF_TEXT = 4000;

function rootOf(session: HandoffSession): AgentNode | undefined {
  return session.nodes.find(n => n.id === 'root');
}

function textOf(event: ActivityEvent): string {
  if (typeof event.detail === 'string' && event.detail.length > 0) return event.detail;
  return event.summary ?? '';
}

/** The latest TodoWrite todos, parsed from the newest TodoWrite tool_use event. */
function latestTodos(nodes: AgentNode[]): Array<{ content: string; status: string }> | undefined {
  let best: { ts: number; todos: Array<{ content: string; status: string }> } | undefined;
  for (const node of nodes) {
    for (const event of node.events) {
      if (event.kind !== 'tool_use' || event.tool !== 'TodoWrite') continue;
      if (typeof event.detail !== 'string' || event.detail.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.detail);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const raw = (parsed as { todos?: unknown }).todos;
      if (!Array.isArray(raw)) continue;
      const todos: Array<{ content: string; status: string }> = [];
      for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.content !== 'string' || typeof rec.status !== 'string') continue;
        todos.push({ content: rec.content, status: rec.status });
      }
      if (todos.length === 0) continue;
      if (!best || event.ts >= best.ts) best = { ts: event.ts, todos };
    }
  }
  return best?.todos;
}

/**
 * Builds the prompt for the fallback lead. Order: limit line, old title + cwd, the
 * failed turn's user request (latest user event, else the first prompt), recent
 * assistant texts (newest last, tail-capped), worker slugs, open todos, the
 * continue-the-task instruction, and the plan-approval sentence when relevant.
 * Only parsed todos carry tool data over; no file contents.
 */
export function buildHandoff(session: HandoffSession, info: LimitInfo): string {
  const root = rootOf(session);
  const resets = info.resetsAt ? new Date(info.resetsAt).toLocaleString() : 'unknown';
  const lines: string[] = [];
  lines.push(
    `You are taking over from a Claude Code session that hit its plan limit (resets ${resets}).`,
  );
  lines.push(`Old session: "${session.title}" in ${session.cwd}.`);

  const users = (root?.events ?? []).filter(e => e.kind === 'user');
  const failed = users.length > 0 ? textOf(users[users.length - 1]!) : (root?.prompt ?? '');
  lines.push(`Failed request:\n${failed || '(no request recorded)'}`);

  const texts = session.nodes
    .flatMap(node => node.events.map(event => ({ ts: event.ts, event })))
    .filter(({ event }) => event.kind === 'text')
    .sort((a, b) => a.ts - b.ts)
    .map(({ event }) => textOf(event))
    .filter(text => text.length > 0);
  const joined = texts.join('\n\n');
  const kept = joined.length > MAX_HANDOFF_TEXT ? joined.slice(joined.length - MAX_HANDOFF_TEXT) : joined;
  lines.push(`Recent assistant output (newest last):\n${kept || '(none)'}`);

  const workers = session.nodes.filter(node => node.kind === 'worker');
  if (workers.length > 0) {
    lines.push(
      `Active workers: ${workers.map(w => w.worker?.slug ?? w.description ?? w.id).join(', ')}`,
    );
  }

  const todos = latestTodos(session.nodes);
  if (todos) {
    lines.push(`Open todos:\n${todos.map(t => `- [${t.status}] ${t.content}`).join('\n')}`);
  }

  lines.push(
    'First run `git status`, `git diff` and `git log -5` in the cwd; do not redo finished steps; finish the task. In Antigravity, implementation goes to `opencode-task` workers (SWARMKIT_AGY_LEAD=1 is set); in OpenCode, to your own subagents.',
  );
  if (session.permissionMode === 'plan') {
    lines.push('The plan was not approved yet: present it and ask for approval before changing files.');
  }
  return lines.join('\n\n');
}

/** Minimal SDK surface the limit handler needs (the real SdkSessions satisfies it). */
export interface LimitSdk {
  get(id: string): (HandoffSession & {
    fallbackOf?: { sessionId: string; title: string };
    limitReached?: LimitReached;
  }) | undefined;
  permissionModeOf?(id: string): string | undefined;
  start(opts: {
    prompt: string;
    cwd: string;
    runtime: Runtime;
    title: string;
    fallbackOf: { sessionId: string; title: string };
  }): string;
  resolveLimit(id: string, fallback: LimitReached['fallback']): void;
}

export interface LimitHandlerDeps {
  sdk: LimitSdk;
  /** Fast lane limits (agy + opencode limits only); injectable for tests. */
  getLaneLimits: () => Promise<LaneReport>;
  runtimesStatus: () => RuntimesResponse;
  notifyLimit: (args: {
    oldId: string;
    title: string;
    resetsAt: string | null;
    fallback: LimitReached['fallback'];
  }) => void;
}

/**
 * Handles one plan-limit hit: picks a free lane and starts the fallback lead with
 * the handoff prompt, or records a null fallback when disabled or no lane is free.
 * Never falls back from a fallback session.
 */
export function createLimitHandler(deps: LimitHandlerDeps): (
  sessionId: string,
  info: LimitInfo,
) => Promise<void> {
  return async (sessionId: string, info: LimitInfo): Promise<void> => {
    const src = deps.sdk.get(sessionId);
    if (!src || src.fallbackOf) return;
    if (process.env.SWARMKIT_FALLBACK === 'off') {
      deps.sdk.resolveLimit(sessionId, null);
      deps.notifyLimit({ oldId: sessionId, title: src.title, resetsAt: info.resetsAt, fallback: null });
      return;
    }
    let lane: FallbackLane | null = null;
    try {
      lane = pickLane(await deps.getLaneLimits(), deps.runtimesStatus());
    } catch {
      lane = null;
    }
    if (!lane) {
      deps.sdk.resolveLimit(sessionId, null);
      deps.notifyLimit({ oldId: sessionId, title: src.title, resetsAt: info.resetsAt, fallback: null });
      return;
    }
    const permissionMode = deps.sdk.permissionModeOf?.(sessionId);
    const prompt = buildHandoff(
      { id: src.id, title: src.title, cwd: src.cwd, nodes: src.nodes, ...(permissionMode ? { permissionMode } : {}) },
      info,
    );
    const newId = deps.sdk.start({
      prompt,
      cwd: src.cwd,
      runtime: lane,
      title: src.title,
      fallbackOf: { sessionId, title: src.title },
    });
    deps.sdk.resolveLimit(sessionId, { sessionId: newId, runtime: lane });
    deps.notifyLimit({
      oldId: sessionId,
      title: src.title,
      resetsAt: info.resetsAt,
      fallback: { sessionId: newId, runtime: lane },
    });
  };
}
