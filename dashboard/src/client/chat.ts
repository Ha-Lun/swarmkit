// Chat transcript helpers: pure event-to-item mapping, no React.
import type { OrbState } from 'thinking-orbs';
import { modelLabel } from './format';
import type { ActivityEvent, AgentNode, PermissionRequest, Status, WorkerTask } from '../shared/types';

export type ChatItem =
  | { type: 'user'; id: string; ts: number; text: string; images?: string[]; queued?: boolean }
  | { type: 'assistant'; id: string; ts: number; text: string }
  | { type: 'thinking'; id: string; ts: number; text: string; summary: string }
  | { type: 'tools'; id: string; ts: number; events: ActivityEvent[]; counts: Array<{ tool: string; count: number }> }
  | { type: 'handoff'; id: string; ts: number; childId: string }
  | { type: 'permission'; id: string; ts: number; event: ActivityEvent }
  | { type: 'note'; id: string; ts: number; text: string; isError?: boolean };
export type TabPhase = 'live' | 'waiting' | 'done' | 'error';
export interface AgentTab { node: AgentNode; phase: TabPhase }

const STORED_IMAGE_RE = /^\/api\/sessions\/[^/]+\/images\/\d{1,4}\.(png|jpg|gif|webp)$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;

/**
 * Only these image URLs may render as <img>: stored session images and
 * demo data URLs. Anything else (remote, blob:, javascript:, svg, …)
 * is dropped silently by the caller.
 */
export function isSafeImageUrl(url: string): boolean {
  return STORED_IMAGE_RE.test(url) || DATA_IMAGE_RE.test(url);
}

const SEARCH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']);
const SHAPE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEAVE_TOOLS = new Set(['Agent', 'Task']);

export function buildChat(node: AgentNode, children: AgentNode[]): ChatItem[] {
  const childIds = new Set(children.map((c) => c.id));
  const out: ChatItem[] = [];
  let cur: Extract<ChatItem, { type: 'tools' }> | null = null;

  const endGroup = () => {
    cur = null;
  };

  for (const e of node.events) {
    if (e.kind === 'tool_use' && e.toolUseId != null && childIds.has(e.toolUseId)) {
      endGroup();
      out.push({ type: 'handoff', id: e.id, ts: e.ts, childId: e.toolUseId });
      continue;
    }
    if (e.kind === 'tool_result' && e.toolUseId != null && childIds.has(e.toolUseId)) {
      endGroup();
      continue;
    }
    if (e.kind === 'tool_use' || e.kind === 'tool_result') {
      if (!cur) {
        cur = { type: 'tools', id: e.id, ts: e.ts, events: [], counts: [] };
        out.push(cur);
      }
      cur.events.push(e);
      if (e.kind === 'tool_use') {
        const tool = e.tool ?? 'Tool';
        const found = cur.counts.find((c) => c.tool === tool);
        if (found) found.count += 1;
        else cur.counts.push({ tool, count: 1 });
      }
      continue;
    }
    endGroup();
    if (e.kind === 'user') {
      const safeImages = (e.images ?? []).filter(isSafeImageUrl);
      out.push({
        type: 'user',
        id: e.id,
        ts: e.ts,
        text: e.detail ?? e.summary,
        ...(safeImages.length ? { images: [...safeImages] } : {}),
        ...(e.queued ? { queued: true } : {}),
      });
    } else if (e.kind === 'text') {
      out.push({ type: 'assistant', id: e.id, ts: e.ts, text: e.detail ?? e.summary });
    } else if (e.kind === 'thinking') {
      out.push({ type: 'thinking', id: e.id, ts: e.ts, text: e.detail ?? e.summary, summary: e.summary });
    } else if (e.kind === 'permission') {
      out.push({ type: 'permission', id: e.id, ts: e.ts, event: e });
    } else if (e.kind === 'result' || e.kind === 'system') {
      out.push({ type: 'note', id: e.id, ts: e.ts, text: e.summary, isError: e.isError });
    }
  }
  // A tools group with no tool_use (only orphan results) would render as a
  // bare "Tools" row with nothing inside — drop it entirely.
  return out.filter((item) => item.type !== 'tools' || item.events.some((x) => x.kind === 'tool_use'));
}

/** The server appends one `🖼 image` line per stored image to the user text. */
const IMAGE_MARK_LINE = /^\s*🖼 image\s*$/;

/** Drop the server's per-image marker lines; the thumbnails carry that meaning. */
export function stripImageMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !IMAGE_MARK_LINE.test(line))
    .join('\n')
    .trimEnd();
}

export function orbState(node: AgentNode, waiting: boolean): OrbState {
  if (waiting) return 'listening';
  if (node.status === 'idle' || node.status === 'done') return 'breathing';
  const last = node.events[node.events.length - 1];
  if (!last) return 'connecting';
  if (last.kind === 'thinking') return 'solving';
  if (last.kind === 'text') return 'composing';
  if (last.kind === 'tool_use' || last.kind === 'tool_result' || last.kind === 'permission') {
    const tool = last.tool ?? '';
    if (SEARCH_TOOLS.has(tool)) return 'searching';
    if (SHAPE_TOOLS.has(tool)) return 'shaping';
    if (WEAVE_TOOLS.has(tool)) return 'weaving';
    if (tool === 'Bash') {
      const hay = `${last.summary ?? ''} ${last.detail ?? ''}`;
      if (hay.includes('agy-task') || hay.includes('opencode-task')) return 'weaving';
    }
    return 'working';
  }
  return 'working';
}

export function orbLabel(state: OrbState): string {
  switch (state) {
    case 'listening': return 'Waiting for you…';
    case 'connecting': return 'Starting…';
    case 'solving': return 'Thinking…';
    case 'composing': return 'Writing…';
    case 'searching': return 'Searching…';
    case 'shaping': return 'Editing…';
    case 'weaving': return 'Handing off…';
    case 'breathing': return 'Idle';
    default: return 'Working…';
  }
}

/** Display name for an agent: `lane · slug` for tree-linked workers, else its agent type. */
export function agentLabel(node: AgentNode): string {
  return node.kind === 'worker' && node.worker ? `${node.worker.lane} · ${node.worker.slug}` : node.agentType;
}

/** Subtitle under an agent name: the task description, or for workers the --agent specialist. Full text, CSS truncates. */
export function agentSubtitle(node: AgentNode, task?: WorkerTask): string {
  if (node.kind === 'worker') return task?.agent ?? node.worker?.agent ?? node.description ?? '';
  return node.description ?? '';
}

/** Tooltip text for an agent: name, subtitle and model in full. */
export function agentHint(node: AgentNode, task?: WorkerTask): string {
  return [agentLabel(node), agentSubtitle(node, task), modelLabel(task?.model ?? node.model)].filter(Boolean).join(' · ');
}

/** Shell label a worker node gets when nothing better is known: "agy worker probe-plain (gemini-3.8-flash)". */
const SHELL_LABEL = /^(agy|opencode) worker \S+( \(.*\))?$/;
/** A prompt line that is just the delegation command, not a task description. */
const SHELL_COMMAND = /^\$?\s*(agy|opencode)-task\b/;

/** Text for a card's description line. Worker descriptions that only repeat the shell label are replaced by the task's first prompt line or last tool, else ''. */
export function agentDescription(node: AgentNode, task?: WorkerTask): string {
  const desc = node.description?.trim() ?? '';
  if (node.kind !== 'worker' || !SHELL_LABEL.test(desc)) return desc;
  const line = node.prompt?.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line && !SHELL_COMMAND.test(line) && !SHELL_LABEL.test(line)) return line.slice(0, 200);
  return task?.lastTool ?? '';
}

/** Effective state of a node: a matching worker task overrides it; a pending permission turns a live node into 'waiting'. */
export function agentState(node: AgentNode, task?: WorkerTask, hasPermission = false): Status {
  let state: Status = node.status;
  if (task) {
    if (task.state === 'running') state = 'running';
    else if (task.state === 'ok') state = 'done';
    else if (task.state === 'not-ok') state = 'error';
    else if (task.state === 'unfinished') state = 'stopped';
  }
  if (hasPermission && (state === 'running' || state === 'waiting')) return 'waiting';
  return state;
}

/** Id prefix of a synthetic "Done (n)" node standing in for a parent's finished children. */
const DONE_PREFIX = 'done:';

/** The finished children of one parent that the map folds into a single node. */
export interface DoneGroup {
  /** Synthetic node id, `done:<parentId>`. */
  id: string;
  parentId: string;
  /** Every folded agent: the finished children and all their (finished) descendants. */
  members: AgentNode[];
}

export interface FoldResult {
  /** The visible nodes: unfolded originals plus one synthetic node per folded group. */
  nodes: AgentNode[];
  /** Folded groups by synthetic id. */
  groups: Map<string, DoneGroup>;
  /** Parents with a finished set worth folding (folded or not) -> how many agents it holds. */
  foldable: Map<string, number>;
}

/** Distinct agent names in a folded group with repeat counts ("explore ×3"), in first-seen order. */
export function doneNames(members: AgentNode[]): string[] {
  const counts = new Map<string, number>();
  for (const m of members) {
    const name = m.kind === 'worker' && m.worker ? m.worker.slug : agentLabel(m);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts, ([name, n]) => (n > 1 ? `${name} ×${n}` : name));
}

const FINISHED_STATES: ReadonlySet<Status> = new Set(['done', 'idle']);

/**
 * Folds finished children into one `done:<parentId>` node per parent so live work and failures stay in focus.
 * A child folds when it is done/idle and so is everything below it; running, waiting, failed and stopped
 * agents (and any ancestor of one) always stay visible. Parents listed in `expanded` show their children.
 * A lone finished child stays a card: folding one agent saves nothing.
 */
export function foldDone(
  nodes: AgentNode[],
  expanded: ReadonlySet<string>,
  stateOf: (node: AgentNode) => Status = (n) => n.status,
): FoldResult {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const kids = new Map<string, AgentNode[]>();
  for (const n of nodes) {
    if (n.parentId && byId.has(n.parentId) && n.parentId !== n.id) {
      const list = kids.get(n.parentId);
      if (list) list.push(n);
      else kids.set(n.parentId, [n]);
    }
  }

  // settled: finished, and so is every descendant. The visiting set guards parent cycles.
  const settledMemo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const settled = (n: AgentNode): boolean => {
    const known = settledMemo.get(n.id);
    if (known !== undefined) return known;
    if (visiting.has(n.id)) return true;
    visiting.add(n.id);
    const ok = FINISHED_STATES.has(stateOf(n)) && (kids.get(n.id) ?? []).every(settled);
    visiting.delete(n.id);
    settledMemo.set(n.id, ok);
    return ok;
  };
  const subtree = (n: AgentNode, seen = new Set<string>()): AgentNode[] => {
    if (seen.has(n.id)) return [];
    seen.add(n.id);
    return [n, ...(kids.get(n.id) ?? []).flatMap((k) => subtree(k, seen))];
  };

  // Per parent: its finished children, when folding them saves at least one card.
  const finished = new Map<string, AgentNode[]>();
  const foldable = new Map<string, number>();
  for (const [parentId, list] of kids) {
    const folded = list.filter(settled);
    const count = folded.flatMap((k) => subtree(k)).length;
    if (count < 2) continue;
    finished.set(parentId, folded);
    foldable.set(parentId, count);
  }

  // Walk from the roots so a group only exists where its parent is itself visible.
  const groups = new Map<string, DoneGroup>();
  const out: AgentNode[] = [];
  const seen = new Set<string>();
  const walk = (n: AgentNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    out.push(n);
    const list = kids.get(n.id) ?? [];
    const folded = !expanded.has(n.id) ? (finished.get(n.id) ?? []) : [];
    if (folded.length > 0) {
      const id = `${DONE_PREFIX}${n.id}`;
      const members = folded.flatMap((k) => subtree(k));
      groups.set(id, { id, parentId: n.id, members });
      for (const m of members) seen.add(m.id);
      out.push({
        id,
        sessionId: n.sessionId,
        parentId: n.id,
        kind: 'subagent',
        agentType: 'Done',
        status: 'done',
        // Sorts after its siblings so the group sits at the end of the row.
        startedAt: Math.max(...list.map((k) => k.startedAt)) + 1,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        toolCounts: {},
        events: [],
      });
    }
    for (const k of list) if (!folded.includes(k)) walk(k);
  };
  for (const n of nodes) if (!n.parentId || !byId.has(n.parentId) || n.parentId === n.id) walk(n);
  for (const n of nodes) walk(n); // parent cycles unreachable from any root
  return { nodes: out, groups, foldable };
}

/** Lane colours, kept in sync with --rt-claude / --rt-opencode / --rt-agy / --ink / --text-3 (the orb takes a literal colour). */
const ORB = { claude: '#d97757', opencode: '#e5484d', agy: '#4f8cff', cream: '#e8e2d6', dim: '#a8a297' } as const;

export function orbColor(node: AgentNode, task?: WorkerTask): string {
  if (node.kind === 'worker') {
    const lane = task?.lane ?? node.worker?.lane;
    return lane === 'agy' ? ORB.agy : ORB.opencode;
  }
  const model = (task?.model ?? node.model ?? '').toLowerCase();
  if (node.kind === 'main') {
    if (model.startsWith('opencode-go/')) return ORB.opencode;
    if (model.includes('gemini')) return ORB.agy;
  }
  if (model.includes('opus')) return ORB.claude;
  if (model.includes('sonnet')) return ORB.cream;
  if (node.kind === 'main') return ORB.claude;
  return ORB.dim;
}

export function agentTabs(nodes: AgentNode[], now: number, permissions: PermissionRequest[]): AgentTab[] {
  const permNodes = new Set(permissions.map((p) => p.nodeId));
  const out: AgentTab[] = [];
  const kids = nodes
    .filter((n) => n.kind !== 'main' && n.parentId !== null)
    .sort((a, b) => (a.startedAt - b.startedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const n of kids) {
    const isActive = n.status === 'running' || n.status === 'waiting';
    if (isActive && (n.status === 'waiting' || permNodes.has(n.id))) {
      out.push({ node: n, phase: 'waiting' });
      continue;
    }
    if (n.status === 'running') {
      out.push({ node: n, phase: 'live' });
      continue;
    }
    if ((n.status === 'done' || n.status === 'idle') && n.endedAt != null && now >= n.endedAt && now - n.endedAt <= 5000) {
      out.push({ node: n, phase: 'done' });
      continue;
    }
    if ((n.status === 'error' || n.status === 'stopped') && n.endedAt != null && now >= n.endedAt && now - n.endedAt <= 10000) {
      out.push({ node: n, phase: 'error' });
      continue;
    }
  }
  return out;
}

export function matchWorkerTask(node: AgentNode, workers: WorkerTask[]): WorkerTask | undefined {
  if (node.kind !== 'worker') return undefined;
  return workers.find(
    (w) =>
      (w.sessionId != null && w.nodeId != null && w.sessionId === node.sessionId && w.nodeId === node.id) ||
      (node.worker != null && w.lane === node.worker.lane && w.slug === node.worker.slug),
  );
}
