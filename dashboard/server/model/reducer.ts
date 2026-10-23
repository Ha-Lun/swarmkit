import { MAX_DETAIL, MAX_EVENTS } from '../../src/shared/types.ts';
import type {
  ActivityEvent,
  AgentNode,
  ServerEvent,
  TokenUsage,
} from '../../src/shared/types.ts';
import { estimateCost } from './pricing.ts';
import { parseWorkerCommand } from './workers.ts';

export interface SessionTree {
  sessionId: string;
  /** All nodes by id; 'root' is the main agent. */
  nodes: Map<string, AgentNode>;
  /** tool_use_id -> id of the node that made that tool call (routes tool_results and permission requests). */
  toolOwner: Map<string, string>;
  /** cwd seen in the transcript, when the messages carry one. */
  cwd?: string;
  /** SDK agent id (toolUseResult.agentId of async-launched subagents) -> node id. */
  agentIds?: Map<string, string>;
  /** node id -> message.id already counted for cost/tokens (streamed lines share one). */
  costedMessages?: Map<string, Set<string>>;
  /** node id -> block keys already applied; prevents duplicate events/counts when a line is re-applied. */
  seenBlocks?: Map<string, Set<string>>;
}

export interface TreeInit {
  startedAt: number;
  /** Main-thread agent name; defaults to 'main'. */
  agentType?: string;
  prompt?: string;
}

export interface ApplyOptions {
  /** Force the node for this message: used for transcript lines read from a subagent file (agent-<id>.jsonl). */
  nodeId?: string;
}

type Raw = Record<string, unknown>;

const emptyTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function createTree(sessionId: string, init: TreeInit): SessionTree {
  const root: AgentNode = {
    id: 'root',
    sessionId,
    parentId: null,
    kind: 'main',
    agentType: init.agentType ?? 'main',
    prompt: init.prompt,
    status: 'running',
    startedAt: init.startedAt,
    costUsd: 0,
    tokens: emptyTokens(),
    toolCounts: {},
    events: [],
  };
  return {
    sessionId,
    nodes: new Map<string, AgentNode>([['root', root]]),
    toolOwner: new Map<string, string>(),
    agentIds: new Map<string, string>(),
    costedMessages: new Map<string, Set<string>>(),
    seenBlocks: new Map<string, Set<string>>(),
  };
}

/**
 * Applies one raw message to the tree and returns the events to broadcast.
 * `msg` is either an Agent SDK message (SDKMessage: has `parent_tool_use_id`) or one parsed line of a
 * Claude Code transcript (~/.claude/projects/<proj>/<session>.jsonl or .../subagents/agent-<id>.jsonl).
 * Unknown shapes are ignored (return []).
 */
export function applyMessage(tree: SessionTree, msg: unknown, opts?: ApplyOptions): ServerEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  tree.agentIds ??= new Map<string, string>();
  tree.costedMessages ??= new Map<string, Set<string>>();
  tree.seenBlocks ??= new Map<string, Set<string>>();
  const m = msg as Raw;
  try {
    switch (m.type) {
      case 'assistant':
        return applyAssistant(tree, m, opts);
      case 'user':
        return applyUser(tree, m, opts);
      case 'system':
        return applySystem(tree, m);
      case 'result':
        return applyResult(tree, m);
      case 'agent-setting':
        return applyAgentSetting(tree, m);
      default:
        return [];
    }
  } catch {
    // One malformed message must never break the whole tree.
    return [];
  }
}

/** Node id that owns a tool_use_id, or 'root'. */
export function ownerOf(tree: SessionTree, toolUseId: string | undefined): string {
  return (toolUseId && tree.toolOwner.get(toolUseId)) || 'root';
}

/** Sets a node's status (used for permission waits, interrupts and stops) and returns the node.upsert to broadcast. */
export function setStatus(tree: SessionTree, nodeId: string, status: AgentNode['status']): ServerEvent[] {
  const node = tree.nodes.get(nodeId);
  if (!node) return [];
  let changed = node.status !== status;
  node.status = status;
  const ending = isEnding(status);
  if (ending && !node.endedAt) {
    node.endedAt = Date.now();
    changed = true;
  } else if (!ending && node.endedAt !== undefined) {
    node.endedAt = undefined;
    changed = true;
  }
  if (!changed) return [];
  return [upsertEvent(node)];
}

/**
 * Returns the node if it exists, otherwise creates it. Never mutates an existing node's
 * fields: used by the reducer for Agent/Task/Bash child nodes and by the transcript
 * watcher for placeholder nodes built from agent-<id>.meta.json.
 */
export function ensureNode(
  tree: SessionTree,
  nodeId: string,
  fields: {
    parentId?: string;
    kind?: AgentNode['kind'];
    agentType?: string;
    description?: string;
    prompt?: string;
    model?: string;
    worker?: AgentNode['worker'];
    status?: AgentNode['status'];
    startedAt?: number;
  } = {},
): AgentNode {
  const existing = tree.nodes.get(nodeId);
  if (existing) return existing;
  const node: AgentNode = {
    id: nodeId,
    sessionId: tree.sessionId,
    parentId: fields.parentId ?? 'root',
    kind: fields.kind ?? 'subagent',
    agentType: fields.agentType ?? 'general-purpose',
    description: fields.description,
    prompt: fields.prompt,
    model: fields.model,
    status: fields.status ?? 'running',
    startedAt: fields.startedAt ?? Date.now(),
    costUsd: 0,
    tokens: emptyTokens(),
    toolCounts: {},
    events: [],
    worker: fields.worker,
  };
  tree.nodes.set(nodeId, node);
  return node;
}

/** node.upsert event with the node minus its events. */
export function upsertEvent(node: AgentNode): ServerEvent {
  return { type: 'node.upsert', node: headOf(node) };
}

/** A node without its events, for the wire format. */
export function headOf(node: AgentNode): Omit<AgentNode, 'events'> {
  const { events, ...head } = node;
  void events;
  return head;
}

// ---------------------------------------------------------------------------
// Output collector: per-node upsert + activity events, nothing new -> nothing emitted.
// ---------------------------------------------------------------------------

class Out {
  private map = new Map<AgentNode, ActivityEvent[]>();

  touch(node: AgentNode, event?: ActivityEvent): void {
    if (!event) {
      if (!this.map.has(node)) this.map.set(node, []);
      return;
    }
    // Event ids are unique per node (message uuid / tool_use_id based); skip known ones.
    const nodeEvents = node.events;
    if (nodeEvents.some((e) => e.id === event.id)) return;
    let list = this.map.get(node);
    if (!list) {
      list = [];
      this.map.set(node, list);
    }
    if (list.some((e) => e.id === event.id)) return;
    list.push(event);
  }

  hasAny(): boolean {
    for (const [, list] of this.map) if (list.length > 0) return true;
    return this.map.size > 0;
  }

  done(tree: SessionTree): ServerEvent[] {
    if (this.map.size === 0) return [];
    const out: ServerEvent[] = [];
    for (const [node, events] of this.map) {
      for (const e of events) node.events.push(e);
      if (node.events.length > MAX_EVENTS) node.events.splice(0, node.events.length - MAX_EVENTS);
      out.push(upsertEvent(node));
      for (const e of events) {
        out.push({ type: 'node.event', sessionId: tree.sessionId, nodeId: node.id, event: e });
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// assistant
// ---------------------------------------------------------------------------

function applyAssistant(tree: SessionTree, m: Raw, opts?: ApplyOptions): ServerEvent[] {
  const message = asRaw(m.message);
  if (!message) return [];
  const { node, fresh } = resolveNode(tree, m, opts);
  let dirty = fresh;
  const ts = tsOf(m.timestamp);

  const model = str(message.model);
  if (model && node.model !== model) {
    node.model = model;
    dirty = true;
  }
  const usage = asRaw(message.usage);
  const messageId = str(message.id);
  if (usage && messageId && !tree.costedMessages!.get(node.id)?.has(messageId)) {
    countCost(tree, node, messageId, usage, model);
    dirty = true;
  }

  const uuid = str(m.uuid) ?? messageId ?? `assistant:${ts}`;
  const seen = seenSet(tree, node.id);
  const out = new Out();
  const blocks = Array.isArray(message.content) ? message.content : [];
  blocks.forEach((raw, index) => {
    const block = asRaw(raw);
    if (!block) return;
    const key = `${uuid}:${index}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      if (!text) return;
      node.lastActivity = firstLine(text, 200);
      node.result = cap(text);
      dirty = true;
      out.touch(node, { id: key, ts, kind: 'text', summary: firstLine(text, 200), detail: cap(text) });
    } else if (block.type === 'thinking') {
      const thinking = typeof block.thinking === 'string' ? block.thinking : '';
      if (!thinking.trim()) return;
      dirty = true;
      out.touch(node, {
        id: key,
        ts,
        kind: 'thinking',
        summary: firstLine(thinking, 200),
        detail: cap(thinking),
      });
    } else if (block.type === 'tool_use') {
      const toolUseId = str(block.id);
      const name = str(block.name);
      if (!toolUseId || !name) return;
      const input = asRaw(block.input);
      node.toolCounts[name] = (node.toolCounts[name] ?? 0) + 1;
      tree.toolOwner.set(toolUseId, node.id);
      const summary = toolSummary(name, input);
      node.lastActivity = summary;
      dirty = true;
      out.touch(node, {
        id: `${toolUseId}:use`,
        ts,
        kind: 'tool_use',
        tool: name,
        toolUseId,
        summary,
        detail: input ? cap(JSON.stringify(input)) : undefined,
      });
      const child = toolChild(tree, node, name, input, ts, toolUseId);
      if (child) out.touch(child);
    }
  });

  return out.hasAny() || dirty ? out.done(tree) : [];
}

// ---------------------------------------------------------------------------
// user
// ---------------------------------------------------------------------------

function applyUser(tree: SessionTree, m: Raw, opts?: ApplyOptions): ServerEvent[] {
  const message = asRaw(m.message);
  if (!message) return [];
  const { node, fresh } = resolveNode(tree, m, opts);
  const ts = tsOf(m.timestamp);
  const seen = seenSet(tree, node.id);
  const out = new Out();
  let dirty = fresh;
  const content = message.content;

  if (typeof content === 'string') {
    if (m.isMeta !== true && !content.startsWith('<')) {
      const key = `${str(m.uuid) ?? `user:${ts}`}:user`;
      if (!seen.has(key)) {
        seen.add(key);
        if (node.prompt === undefined) {
          node.prompt = content;
          dirty = true;
        }
        if (node.description === undefined) {
          node.description = firstLine(content, 120);
          dirty = true;
        }
        node.lastActivity = firstLine(content, 200);
        dirty = true;
        out.touch(node, {
          id: key,
          ts,
          kind: 'user',
          summary: firstLine(content, 200),
          detail: cap(content),
        });
      }
    }
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      const block = asRaw(raw);
      if (!block || block.type !== 'tool_result') continue;
      const toolUseId = str(block.tool_use_id);
      if (!toolUseId) continue;
      const owner = tree.nodes.get(ownerOf(tree, toolUseId)) ?? tree.nodes.get('root')!;
      const ownerSeen = seenSet(tree, owner.id);
      const key = `${toolUseId}:result`;
      const text = toolResultText(block.content);
      const isError = block.is_error === true;
      if (!ownerSeen.has(key)) {
        ownerSeen.add(key);
        const summary = text ? firstLine(text, 200) : 'tool result';
        if (owner.lastActivity !== summary) {
          owner.lastActivity = summary;
          dirty = true;
        }
        dirty = true;
        out.touch(owner, {
          id: key,
          ts,
          kind: 'tool_result',
          toolUseId,
          summary,
          detail: cap(text),
          isError: isError || undefined,
        });
      }
      // Subagent lifecycle: async-launched ones stay running and register their agent id.
      const sub = tree.nodes.get(toolUseId);
      if (!sub || sub.kind !== 'subagent') continue;
      const operation = asRaw(m.toolUseResult);
      if (operation?.status === 'async_launched') {
        const agentId = str(operation.agentId);
        if (agentId && !tree.agentIds!.has(agentId)) {
          tree.agentIds!.set(agentId, sub.id);
          dirty = true;
          out.touch(sub);
        }
      } else {
        const status: AgentNode['status'] = isError ? 'error' : 'done';
        if (sub.status !== status) {
          sub.status = status;
          dirty = true;
          out.touch(sub);
        }
        if (!sub.endedAt) {
          sub.endedAt = ts;
          dirty = true;
          out.touch(sub);
        }
        if (text && sub.result !== text) {
          sub.result = cap(text);
          dirty = true;
          out.touch(sub);
        }
      }
    }
  }

  return out.hasAny() || dirty ? out.done(tree) : [];
}

// ---------------------------------------------------------------------------
// system / result / agent-setting
// ---------------------------------------------------------------------------

function applySystem(tree: SessionTree, m: Raw): ServerEvent[] {
  const subtype = str(m.subtype);
  if (subtype === 'init') {
    const root = tree.nodes.get('root')!;
    let dirty = false;
    const model = str(m.model);
    if (model && root.model !== model) {
      root.model = model;
      dirty = true;
    }
    const cwd = str(m.cwd);
    if (cwd && tree.cwd !== cwd) {
      tree.cwd = cwd;
      dirty = true;
    }
    return dirty ? [upsertEvent(root)] : [];
  }
  if (subtype !== 'task_started' && subtype !== 'task_progress' && subtype !== 'task_notification') {
    return [];
  }
  const nodeId = str(m.tool_use_id);
  const node = nodeId ? tree.nodes.get(nodeId) : undefined;
  if (!node) return [];
  const out = new Out();
  const ts = tsOf(m.timestamp);
  if (subtype === 'task_started') {
    const description = str(m.description);
    const subagentType = str(m.subagent_type);
    if (node.status !== 'running') {
      node.status = 'running';
      node.endedAt = undefined;
      out.touch(node);
    }
    if (description && node.description === undefined) {
      node.description = description;
      out.touch(node);
    }
    if (subagentType && node.agentType !== subagentType) {
      node.agentType = subagentType;
      node.model = undefined;
      out.touch(node);
    }
  } else if (subtype === 'task_progress') {
    const summary = str(m.summary);
    const lastTool = str(m.last_tool_name);
    const activity = summary ? firstLine(summary, 200) : lastTool ? `${lastTool} (in progress)` : undefined;
    if (activity && node.lastActivity !== activity) {
      node.lastActivity = activity;
      out.touch(node);
    }
  } else {
    const mapped = mapStatus(str(m.status));
    const summary = str(m.summary);
    if (summary && node.result !== summary) {
      node.result = summary;
      out.touch(node);
    }
    if (summary && node.lastActivity !== firstLine(summary, 200)) {
      node.lastActivity = firstLine(summary, 200);
      out.touch(node);
    }
    if (mapped && node.status !== mapped) {
      node.status = mapped;
      out.touch(node);
    }
    if (isEnding(node.status) && !node.endedAt) {
      node.endedAt = ts;
      out.touch(node);
    }
  }
  return out.done(tree);
}

function applyResult(tree: SessionTree, m: Raw): ServerEvent[] {
  const root = tree.nodes.get('root')!;
  const out = new Out();
  if (typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd) && root.costUsd !== m.total_cost_usd) {
    root.costUsd = m.total_cost_usd;
    out.touch(root);
  }
  const status: AgentNode['status'] = m.is_error === true ? 'error' : 'idle';
  if (root.status !== status) {
    root.status = status;
    out.touch(root);
  }
  const result = stringified(m.result);
  if (result && root.result !== result) {
    root.result = result;
    out.touch(root);
  }
  if (result && root.lastActivity !== firstLine(result, 200)) {
    root.lastActivity = firstLine(result, 200);
    out.touch(root);
  }
  const seen = seenSet(tree, root.id);
  const key = `${str(m.uuid) ?? `result:${str(m.subtype) ?? ''}`}:result`;
  if (!seen.has(key)) {
    seen.add(key);
    out.touch(root, {
      id: key,
      ts: tsOf(m.timestamp),
      kind: 'result',
      summary: root.lastActivity ?? `result ${str(m.subtype) ?? ''}`,
      detail: result ? cap(result) : undefined,
      isError: m.is_error === true || undefined,
    });
  }
  return out.done(tree);
}

function applyAgentSetting(tree: SessionTree, m: Raw): ServerEvent[] {
  const agent = str(m.agentSetting);
  if (!agent) return [];
  const root = tree.nodes.get('root')!;
  if (root.agentType === agent) return [];
  root.agentType = agent;
  return [upsertEvent(root)];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Node for a message: opts.nodeId forces it (transcript subagent files), otherwise parent_tool_use_id. */
function resolveNode(tree: SessionTree, m: Raw, opts?: ApplyOptions): { node: AgentNode; fresh: boolean } {
  const forced = opts?.nodeId ?? str(m.parent_tool_use_id);
  if (forced) {
    if (tree.nodes.has(forced)) return { node: tree.nodes.get(forced)!, fresh: false };
    return { node: ensureNode(tree, forced, { kind: 'subagent' }), fresh: true };
  }
  return { node: tree.nodes.get('root')!, fresh: false };
}

function toolChild(
  tree: SessionTree,
  parent: AgentNode,
  name: string,
  input: Raw | undefined,
  ts: number,
  toolUseId: string,
): AgentNode | undefined {
  if (name === 'Agent' || name === 'Task') {
    const v = input ?? {};
    return ensureNode(tree, toolUseId, {
      parentId: parent.id,
      kind: 'subagent',
      agentType: str(v.subagent_type) ?? 'general-purpose',
      description: stringified(v.description),
      prompt: stringified(v.prompt),
      model: stringified(v.model),
      startedAt: ts,
    });
  }
  if (name === 'Bash' && input) {
    const wc = parseWorkerCommand(stringified(input.command) ?? '');
    if (!wc) return undefined;
    return ensureNode(tree, toolUseId, {
      parentId: parent.id,
      kind: 'worker',
      agentType: wc.lane === 'agy' ? 'agy-task' : 'opencode-task',
      description: (wc.prompt ? cap(wc.prompt, 120) : stringified(input.description)) ?? undefined,
      prompt: wc.prompt,
      model: wc.model,
      worker: { lane: wc.lane, slug: wc.slug },
      startedAt: ts,
    });
  }
  return undefined;
}

function toolSummary(name: string, input: Raw | undefined): string {
  const v = (input ?? {}) as Raw;
  let summary: string = name;
  if (name === 'Bash') summary = stringified(v.description) ?? stringified(v.command) ?? name;
  else if (name === 'Read' || name === 'Edit' || name === 'Write') summary = stringified(v.file_path) ?? name;
  else if (name === 'Grep' || name === 'Glob') summary = stringified(v.pattern) ?? name;
  else if (name === 'WebFetch') summary = stringified(v.url) ?? name;
  else if (name === 'WebSearch') summary = stringified(v.query) ?? name;
  else if (name === 'Agent' || name === 'Task') {
    const type = stringified(v.subagent_type) ?? 'subagent';
    summary = `${type}: ${stringified(v.description) ?? stringified(v.prompt) ?? type}`;
  }
  return firstLine(summary, 200);
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const block = asRaw(part);
        return block && typeof block.text === 'string' ? block.text : '';
      })
      .filter((t) => t.length > 0)
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/** Counts usage once per (node, message.id): streamed partial lines share one usage record. */
function countCost(tree: SessionTree, node: AgentNode, messageId: string, usage: Raw, model: string | undefined): void {
  let set = tree.costedMessages!.get(node.id);
  if (!set) {
    set = new Set<string>();
    tree.costedMessages!.set(node.id, set);
  }
  if (set.has(messageId)) return;
  set.add(messageId);
  const tokens: TokenUsage = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
  node.tokens.input += tokens.input;
  node.tokens.output += tokens.output;
  node.tokens.cacheRead += tokens.cacheRead;
  node.tokens.cacheWrite += tokens.cacheWrite;
  node.costUsd += estimateCost(model ?? node.model, tokens);
}

function seenSet(tree: SessionTree, nodeId: string): Set<string> {
  let set = tree.seenBlocks!.get(nodeId);
  if (!set) {
    set = new Set<string>();
    tree.seenBlocks!.set(nodeId, set);
  }
  return set;
}

function isEnding(status: AgentNode['status']): boolean {
  return status === 'done' || status === 'error' || status === 'stopped';
}

function mapStatus(status: string | undefined): AgentNode['status'] | undefined {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  if (status === 'stopped') return 'stopped';
  if (status === 'running') return 'running';
  return undefined;
}

function cap(text: string, max = MAX_DETAIL): string {
  return text.length > max ? text.slice(0, max) : text;
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n', 1)[0] ?? text;
  return line.length > max ? line.slice(0, max) : line;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stringified(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v === undefined || v === null) return undefined;
  let text: string;
  try {
    text = JSON.stringify(v) ?? '';
  } catch {
    return undefined;
  }
  return text.length > 0 ? text : undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function tsOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function asRaw(v: unknown): Raw | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : undefined;
}
