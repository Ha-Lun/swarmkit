// Contract shared by the server and the client. Change it only on purpose: both sides depend on it.

export type SessionSource = 'page' | 'terminal';
/** running: working; waiting: blocked on a permission decision; idle: page session between turns. */
export type Status = 'running' | 'waiting' | 'idle' | 'done' | 'error' | 'stopped';
export type NodeKind = 'main' | 'subagent' | 'worker';

/** Max events kept per node, in memory and over the wire. */
export const MAX_EVENTS = 500;
/** Max characters of ActivityEvent.detail. */
export const MAX_DETAIL = 20_000;

export interface ActivityEvent {
  /** Stable and unique within the node (message uuid, tool_use_id + ':use' / ':result', ...). */
  id: string;
  /** Epoch ms. */
  ts: number;
  kind: 'user' | 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission' | 'system' | 'result';
  /** Tool name for tool_use, tool_result and permission events. */
  tool?: string;
  toolUseId?: string;
  /** One line, at most 200 characters. */
  summary: string;
  /** Full text, JSON tool input or tool result, at most MAX_DETAIL characters. */
  detail?: string;
  isError?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface WorkerInfo {
  lane: 'agy' | 'opencode';
  slug: string;
  /** From result.json once the worker has finished. */
  ok?: boolean;
  stoppedBy?: string;
  /** From opts.json (start flags) or the parsed command line. */
  model?: string;
  /** The --agent specialist the worker runs as, when any. */
  agent?: string;
}

export interface AgentNode {
  /** 'root' for the main agent; the starting tool_use_id for subagents and workers. */
  id: string;
  sessionId: string;
  parentId: string | null;
  kind: NodeKind;
  /** 'main', the main-thread agent name (e.g. 'lead-dev-hybrid'), the subagent_type, or 'agy-task' / 'opencode-task'. */
  agentType: string;
  /** Raw model id, e.g. 'claude-opus-5-5' or 'opencode-go/glm-5.3-flash'. */
  model?: string;
  /** Short task: the Agent call's description, or the first line of the first prompt. */
  description?: string;
  /** Full prompt given to the agent. */
  prompt?: string;
  status: Status;
  startedAt: number;
  endedAt?: number;
  /** Estimate from token usage; for a page session's root, the SDK's total_cost_usd. */
  costUsd: number;
  tokens: TokenUsage;
  /** Tool name -> number of calls. */
  toolCounts: Record<string, number>;
  /** Summary of the latest event. */
  lastActivity?: string;
  /** Final text of the agent, or the worker's result summary. */
  result?: string;
  worker?: WorkerInfo;
  /** Last MAX_EVENTS events, oldest first. */
  events: ActivityEvent[];
}

/** A node without its events, as sent in node.upsert. */
export type AgentNodeHead = Omit<AgentNode, 'events'>;

export interface PermissionRequest {
  id: string;
  sessionId: string;
  /** The node whose tool call asks (found from the tool_use_id), 'root' if unknown. */
  nodeId: string;
  tool: string;
  toolUseId?: string;
  input: Record<string, unknown>;
  /** The SDK's prompt sentence, e.g. "Claude wants to read foo.txt", when present. */
  title?: string;
  createdAt: number;
}

export interface SessionSummary {
  id: string;
  source: SessionSource;
  /** Basename of cwd. */
  project: string;
  cwd: string;
  /** First user prompt, first line, at most 120 characters. */
  title: string;
  status: Status;
  startedAt: number;
  updatedAt: number;
  costUsd: number;
  /** Main-thread agent name, if any. */
  agent?: string;
  model?: string;
  nodeCount: number;
  pendingPermissions: number;
  /** True when the project settings for cwd are not trusted (no hasTrustDialogAccepted); only user settings are read. */
  untrustedProject?: boolean;
}

export interface SessionDetail extends SessionSummary {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
}

/** Sent over GET /events as `data: <json>` lines. */
export type ServerEvent =
  | { type: 'hello'; sessions: SessionSummary[] }
  | { type: 'session.upsert'; session: SessionSummary }
  | { type: 'session.removed'; sessionId: string }
  | { type: 'node.upsert'; node: AgentNodeHead }
  | { type: 'node.event'; sessionId: string; nodeId: string; event: ActivityEvent }
  | { type: 'permission.request'; request: PermissionRequest }
  | { type: 'permission.resolved'; sessionId: string; id: string; allow: boolean }
  | { type: 'workers.update'; workers: WorkerTask[] };

/** One agy-task / opencode-task directory scanned from the task roots. */
export interface WorkerTask {
  lane: 'agy' | 'opencode';
  /** Task-dir repo key, e.g. 'opencode-config-5dbfaa'. */
  repo: string;
  slug: string;
  state: 'running' | 'ok' | 'not-ok' | 'unfinished';
  model?: string;      // opts.json model, or result.json model
  effort?: string;
  agent?: string;
  startedAt: number;   // epoch ms: mtime of the pid file, else of `base`, else of the dir
  endedAt?: number;    // mtime of result.json
  elapsedS: number;    // running: now - pid mtime; finished: result.json wall_s (else endedAt - startedAt)
  denied: number;
  changes?: string;
  stoppedBy?: string;
  warnings?: string[];
  response?: string;   // first 4000 chars
  branch?: string;
  lastTool?: string;   // e.g. 'edit src/app.ts' (opencode only)
  toolCounts: Record<string, number>;
  /** Tree node that started it, when a known session has a worker node with this lane+slug. */
  sessionId?: string;
  nodeId?: string;
}

// HTTP API bodies. All endpoints need the token (cookie `fleet_token` or header `x-fleet-token`).
// GET  /api/sessions                    -> SessionSummary[]
// GET  /api/sessions/:id                -> SessionDetail
// POST /api/sessions                    StartSessionBody -> StartSessionResponse
// POST /api/sessions/:id/message        -> { text: string } -> { ok: true }
// POST /api/sessions/:id/interrupt      -> { ok: true }
// POST /api/sessions/:id/resume         ResumeSessionBody -> StartSessionResponse
// DELETE /api/sessions/:id              -> { ok: true }   (stops a page session)
// POST /api/permissions/:id             PermissionDecisionBody -> { ok: true }
// GET  /api/agents?cwd=<abs path>       -> AgentsResponse
// GET  /api/cwds                        -> string[]       (recent cwds, most recent first)
// GET  /api/workers                     -> WorkerTask[]
// GET  /api/workers/:lane/:repo/:slug/log -> { lines: string[] }
// GET  /api/dirs?path=<abs>&hidden=1    -> DirListing     (path defaults to $HOME)
// GET  /events                          -> text/event-stream of ServerEvent

export interface StartSessionBody {
  prompt: string;
  /** Absolute path of an existing directory under $HOME. */
  cwd: string;
  agent?: string;
  /** 'opus' | 'sonnet' | 'haiku' or a full model id; omitted = default. */
  model?: string;
}
export interface StartSessionResponse {
  sessionId: string;
}
export interface PermissionDecisionBody {
  allow: boolean;
  /** Required by the SDK on deny; also how the user answers AskUserQuestion. */
  message?: string;
}
export interface AgentInfo {
  name: string;
  description?: string;
  scope: 'user' | 'project';
}
export interface AgentsResponse {
  agents: AgentInfo[];
}
export interface DirEntry { name: string; path: string; isGitRepo: boolean }
export interface DirListing { path: string; parent?: string; entries: DirEntry[] }
export interface ResumeSessionBody { text: string; model?: string }
