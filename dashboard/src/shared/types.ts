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
  /** User events only: URLs of the stored images sent with the message (GET /api/sessions/:id/images/:name). */
  images?: string[];
  /** User events only: display names of the general files sent with the message (stored on disk, never served). */
  files?: string[];
  /** Page user events only: waiting for the running opencode/agy turn to end before the lead reads it. */
  queued?: boolean;
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
  /**
   * What the request is, set by the server: 'question' (AskUserQuestion: answers go back
   * in the decision), 'plan' (ExitPlanMode: approve or send feedback), 'tool' (everything else).
   */
  kind?: 'question' | 'plan' | 'tool';
  toolUseId?: string;
  input: Record<string, unknown>;
  /** The SDK's prompt sentence, e.g. "Claude wants to read foo.txt", when present. */
  title?: string;
  /**
   * True for a terminal Claude Code session's question or plan, relayed through the
   * PermissionRequest hook: deciding it answers the terminal prompt, and
   * PermissionDecisionBody.terminal hands it back to the terminal dialog.
   */
  terminal?: boolean;
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
  /** Which lead runtime drives this page session (terminal sessions never set it). */
  runtime?: Runtime;
  /**
   * True when this ended session could be continued via POST /api/sessions/:id/resume:
   * not running/waiting/idle, its transcript .jsonl exists on disk, its cwd still exists
   * as a directory, and it completed at least one turn. Running/waiting sessions are
   * never resumable (the flag is not relevant while live).
   */
  resumable: boolean;
  /**
   * Set on every terminal session held by a live non-dashboard Claude process:
   * `pane` says a tmux pane is known (a message can be injected into it),
   * `busy` says the process reports anything other than idle.
   */
  terminal?: { pane: boolean; busy: boolean };
  /** True when the project settings for cwd are not trusted (no hasTrustDialogAccepted); only user settings are read. */
  untrustedProject?: boolean;
  /** Set on a Claude page session whose turn was refused by the plan limit (server/fallback.ts). */
  limitReached?: LimitReached;
  /** Set on the session a fallback lead started from: the Claude session it continues. */
  fallbackOf?: { sessionId: string; title: string };
  /** How the Haiku triage picked this Claude page session's model (only set when it ran). */
  triage?: TriageInfo;
}

/** Triage level: trivial and normal run on Sonnet, hard on Opus. */
export type TriageLevel = 'trivial' | 'normal' | 'hard';
/** The triage outcome shown in the info panel; source 'fallback' = Haiku failed or was skipped, Opus used. */
export interface TriageInfo {
  level: TriageLevel;
  /** Short reason, at most 80 chars (empty on a fallback). */
  reason: string;
  source: 'haiku' | 'fallback';
}

/** The plan limit stopped this Claude session; `fallback` is the session that took over, or null when no lane was free. */
export interface LimitReached {
  /** 'five_hour' | 'seven_day' | ... from the SDK's rate_limit_event. */
  window: string;
  /** ISO 8601, or null when the SDK did not say. */
  resetsAt: string | null;
  fallback: { sessionId: string; runtime: Runtime } | null;
}

/** Git state of a session's cwd (server/git.ts), shown in the session header and composer footer. */
export interface GitInfo {
  /** Branch name; the short commit sha when detached. */
  branch: string;
  detached: boolean;
  /** Changed + untracked paths (`git status --porcelain` lines). */
  dirty: number;
  /** Commits ahead of / behind the upstream; 0 without an upstream. */
  ahead: number;
  behind: number;
  /** Set when cwd is a linked worktree: the main checkout's path. */
  worktreeOf?: string;
}

export interface SessionDetail extends SessionSummary {
  nodes: AgentNode[];
  permissions: PermissionRequest[];
}

/** GET /api/sessions/:id/git; `git` is absent when cwd is not inside a git repository (or git failed). */
export interface GitResponse {
  git?: GitInfo;
}

/** A file the agent published into the session's artifacts folder ($SWARMKIT_ARTIFACTS_DIR). */
export interface PublishedArtifact {
  name: string;
  size: number;
  /** Epoch ms. */
  mtime: number;
  /** GET /api/sessions/:id/artifacts/:name (downloads as an attachment). */
  url: string;
}

/** A file the session wrote with Write/Edit/NotebookEdit that still exists inside its cwd. */
export interface WrittenArtifact {
  /** Absolute path, as the tool call named it. */
  path: string;
  /** Path relative to the session cwd. */
  rel: string;
  size: number;
  /** Epoch ms. */
  mtime: number;
  /** GET /api/sessions/:id/written?path=<abs> (downloads as an attachment). */
  url: string;
}

/** GET /api/sessions/:id/artifacts. Published files come from the session's store dir (also after eviction). */
export interface ArtifactsResponse {
  published: PublishedArtifact[];
  written: WrittenArtifact[];
}

/** Sent over GET /events as `data: <json>` lines. */
export type ServerEvent =
  | { type: 'hello'; sessions: SessionSummary[]; build?: string }
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
// GET  /api/sessions/:id/commands       -> CommandsResponse (slash commands of a live page session)
// POST /api/sessions                    StartSessionBody -> StartSessionResponse
// POST /api/sessions/:id/message        SendMessageBody -> { ok: true }
// POST /api/sessions/:id/interrupt      -> { ok: true }
// POST /api/sessions/:id/resume         ResumeSessionBody -> StartSessionResponse
// GET  /api/sessions/:id/images/:name   -> the stored image bytes (name like 1.png; 404 when unknown)
// GET  /api/sessions/:id/artifacts      -> ArtifactsResponse
// GET  /api/sessions/:id/artifacts/:name -> a published file (attachment; 404 when unknown)
// GET  /api/sessions/:id/written?path=  -> a file the session wrote inside its cwd (attachment)
// DELETE /api/sessions/:id              -> { ok: true }   (stops a page session)
// POST /api/permissions/:id             PermissionDecisionBody -> { ok: true }
// POST /api/presence                  PresenceBody -> { ok: true }   (is this tab visible? gates terminal-prompt relay)
// GET  /api/agents?cwd=<abs path>       -> AgentsResponse
// GET  /api/cwds                        -> string[]       (recent cwds, most recent first)
// GET  /api/workers                     -> WorkerTask[]
// GET  /api/workers/:lane/:repo/:slug/log -> { lines: string[] }
// GET  /api/dirs?path=<abs>&hidden=1    -> DirListing     (path defaults to $HOME)
// GET  /api/stars                       -> string[]       (starred folders, existing dirs only)
// POST /api/stars                       SetStarBody -> string[]
// GET  /api/runtimes                    -> RuntimesResponse
// POST /api/agy-hook/:id                -> hook callback from the agy plugin (loopback + x-swarmkit-hook only, no token)
// GET  /api/push                       -> PushKeyResponse  (the server's VAPID public key)
// POST /api/push/status                PushEndpointBody -> PushStatusResponse
// POST /api/push/subscribe             PushSubscribeBody -> { ok: true }
// POST /api/push/unsubscribe           PushEndpointBody -> { ok: true }
// POST /api/push/test                  PushEndpointBody -> { ok: boolean; result: PushSendResult }
// GET  /api/secrets?cwd=<abs path>     -> SecretsListResponse   (names only, never values)
// PUT  /api/secrets                    PutSecretBody -> 204
// DELETE /api/secrets                  DeleteSecretBody -> 204
// GET  /events                          -> text/event-stream of ServerEvent

/** GET /api/secrets?cwd=: the project's secrets (its git root, else the folder itself). Values never leave the server. */
export interface SecretsListResponse {
  /** Resolved project root the secrets are stored under. */
  project: string;
  names: { name: string; updatedAt: number }[];
}

/** PUT /api/secrets: sets or replaces one secret. name: [A-Z][A-Z0-9_]{0,63}, not a reserved env name; value: 1 byte to 8 KB, no NUL. */
export interface PutSecretBody {
  /** Absolute path of an existing folder inside the project. */
  cwd: string;
  name: string;
  value: string;
}

/** DELETE /api/secrets: removes one secret (204 even when it did not exist). */
export interface DeleteSecretBody {
  cwd: string;
  name: string;
}

/** Which lead runtime drives a page session: the Claude Agent SDK, `opencode acp`, or `agy -p`. */
export type Runtime = 'claude' | 'opencode' | 'agy';

/** Non-Claude lead models (first = default), shared by server validation and the client select. */
export const RUNTIME_MODELS: Record<Exclude<Runtime, 'claude'>, string[]> = {
  opencode: [
    'opencode-go/mimo-v2.6-pro',
    'opencode-go/glm-5.3-flash',
    'opencode-go/mimo-v2.6-flash',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/muse-spark-1.3-contributor',
  ],
  agy: [
    'gemini-4-hydrogen-xhigh',
    'gemini-4-hydrogen-high',
    'gemini-4-hydrogen-medium',
    'gemini-4-hydrogen-low',
    'gemini-4-argon-high',
    'gemini-4-argon-medium',
  ],
};

/** Lead-runtime availability on the server's PATH (`claude` is always true). */
export interface RuntimesResponse {
  claude: boolean;
  opencode: boolean;
  agy: boolean;
}

/** Max images per message and max decoded bytes per image. */
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
/** One pasted image: base64 without a `data:` prefix. Never echoed back in events. */
export interface ImageAttachment {
  mediaType: ImageMediaType;
  data: string;
}

/** Max attached general files per message and max decoded bytes per file. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Max images + files per message combined (MAX_IMAGES still caps images alone). */
export const MAX_ATTACHMENTS = 6;
/** Max combined decoded bytes of images + files per message (fits the 48 MB JSON body cap). */
export const MAX_ATTACHMENT_TOTAL_BYTES = 24 * 1024 * 1024;
/** One attached general file: base64 without a `data:` prefix; mediaType is only a label. */
export interface FileAttachment {
  /** Sanitised display name (safeFileName on the server); shown in the user event. */
  name: string;
  mediaType: string;
  data: string;
}

export interface StartSessionBody {
  prompt: string;
  /** Absolute path of an existing directory under $HOME. */
  cwd: string;
  agent?: string;
  /** 'opus' | 'sonnet' | 'haiku' or a full model id; omitted = default. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Which lead runtime drives the session; omitted = 'claude'. */
  runtime?: Runtime;
  /** Up to MAX_IMAGES images; the prompt may then be empty ("(image)" is used). */
  images?: ImageAttachment[];
  /** Up to MAX_ATTACHMENTS images + files combined; stored next to the images and read by the agent. */
  files?: FileAttachment[];
}
export interface StartSessionResponse {
  sessionId: string;
}
/**
 * Heartbeat of a dashboard tab. Send on visibilitychange and every 45 s while visible; the server
 * holds a terminal prompt only while some tab reported visible:true within the last 90 s.
 */
export interface PresenceBody {
  visible: boolean;
  /** Per-tab key (random string, at most 64 chars) so tabs do not overwrite each other. */
  id: string;
}
export interface PermissionDecisionBody {
  allow: boolean;
  /** Required by the SDK on deny (free-text reason). Answers carry AskUserQuestion choices instead. */
  message?: string;
  /** AskUserQuestion answers keyed by the exact question text. */
  answers?: Record<string, string>;
  /** Plan approvals only: the permission mode to continue in (ignored on other requests). */
  mode?: 'auto' | 'acceptEdits';
  /** Terminal requests only ("Answer in terminal"): hand the prompt back to the terminal dialog. */
  terminal?: true;
}
/** Extra decision fields beyond allow/message/answers: plan mode choice, hand back to the terminal. */
export type DecideOptions = Pick<PermissionDecisionBody, 'mode' | 'terminal'>;
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
export interface SetStarBody { path: string; starred: boolean }
/** `fork: true` continues a terminal session as a copy: a new session id, the source untouched. */
export interface ResumeSessionBody { text: string; fork?: boolean; model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; images?: ImageAttachment[]; files?: FileAttachment[] }
export interface SendMessageBody { text: string; images?: ImageAttachment[]; files?: FileAttachment[] }
/** One `/` command the session's runtime accepts as message text (name without the slash). */
export interface SlashCommandInfo { name: string; description?: string; argumentHint?: string }
export interface CommandsResponse { commands: SlashCommandInfo[] }

// GET  /api/usage                     -> UsageReport   (?refresh=1 bypasses the caches, at most once per 30 s)

/** One plan rate-limit window: utilization 0-100, resetsAt ISO 8601. */
export interface UsageLimit { utilization: number | null; resetsAt: string | null }
/** A consumption window over the last `days` days. */
export interface UsageWindow { days: number; tokens: number; costUsd?: number; runs?: number; stopped?: number }
/** Whether a collector answered at all. */
export interface UsageSource { available: boolean; asOf: string | null; error?: string }
/** One OpenCode Go plan window (plan-wide, not per model): utilization 0-100, resetsAt ISO 8601. */
export interface GoLimit { window: 'rolling' | 'weekly' | 'monthly'; utilization: number | null; resetsAt: string | null; limited: boolean }
export interface UsageReport {
  claude: UsageSource & {
    subscription?: string;
    fiveHour?: UsageLimit;
    sevenDay?: UsageLimit;
    sevenDayOpus?: UsageLimit;
    sevenDaySonnet?: UsageLimit;
    source?: 'probe' | 'session';
  };
  opencode: UsageSource & { windows: UsageWindow[]; limits?: GoLimit[]; limitsError?: string };   // days 1, 7, 30: tokens + costUsd (estimated); Go plan limits from opencode.ai (server-side key)
  agy: UsageSource & { windows: UsageWindow[]; limits?: { group: string; window: '5h' | 'weekly'; utilization: number | null; resetsAt: string | null }[] };        // days 1, 7: tokens, runs, stopped + plan limits from `agy -p /usage`
}

// GET  /api/remote-control  -> RemoteControl[]   (live panes only)

/** A running `claude remote-control` / `claude rc` process in a tmux pane; `id` is the pane number. */
export interface RemoteControl {
  id: string;
  name: string;
  cwd?: string;
  /** tmux `session:window`, for attaching by hand. */
  target: string;
  activityAt?: number;
  /** Remote sessions currently served, from the pane's "Capacity: n/m" line. */
  sessions?: number;
  capacity?: number;
  /** The pane's Claude session, to open in the dashboard (absent for a `remote-control` server). */
  sessionId?: string;
}

/** Which notifications a subscribed device wants. */
export interface PushEvents {
  /** A session needs you: a permission, question or plan approval. */
  waiting: boolean;
  /** A session finished its turn (running/waiting -> idle/done). */
  finished: boolean;
  /** A session errored. */
  error: boolean;
  /** An agy/opencode worker finished (ok, not ok or died). */
  workers: boolean;
}

/** PushSubscription.toJSON() as the browser hands it over (expirationTime ignored). */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushKeyResponse {
  /** base64url, uncompressed P-256 point (65 bytes): the applicationServerKey. */
  publicKey: string;
}

export interface PushEndpointBody {
  endpoint: string;
}

export interface PushStatusResponse {
  subscribed: boolean;
  events?: PushEvents;
}

export interface PushSubscribeBody {
  subscription: PushSubscriptionBody;
  events: PushEvents;
  /** Short device label, e.g. "Android Chrome" (at most 60 chars). */
  label?: string;
}

export type PushSendResult = 'ok' | 'gone' | 'error';

/** The JSON a push carries to the service worker (public/sw.js). */
export interface PushPayload {
  title: string;
  body: string;
  /** Notification tag: session id, `worker:<lane>/<repo>/<slug>` or `test`. Same tag replaces. */
  tag: string;
  /** Where a tap goes: `/?session=<id>`, `/?workers=1` or `/`. */
  url: string;
  /** A "Send test" push: the service worker always shows it. */
  test?: boolean;
}
