// Chat transcript helpers: pure event-to-item mapping, no React.
import type { OrbState } from 'thinking-orbs';
import type { ActivityEvent, AgentNode, PermissionRequest, WorkerTask } from '../shared/types';

export type ChatItem =
  | { type: 'user'; id: string; ts: number; text: string }
  | { type: 'assistant'; id: string; ts: number; text: string }
  | { type: 'thinking'; id: string; ts: number; text: string; summary: string }
  | { type: 'tools'; id: string; ts: number; events: ActivityEvent[]; counts: Array<{ tool: string; count: number }> }
  | { type: 'handoff'; id: string; ts: number; childId: string }
  | { type: 'permission'; id: string; ts: number; event: ActivityEvent }
  | { type: 'note'; id: string; ts: number; text: string; isError?: boolean };
export type TabPhase = 'live' | 'waiting' | 'done' | 'error';
export interface AgentTab { node: AgentNode; phase: TabPhase }

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
      out.push({ type: 'user', id: e.id, ts: e.ts, text: e.detail ?? e.summary });
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
  return out;
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
    case 'working': return 'Working…';
    case 'breathing': return 'Idle';
    default: return 'Working…';
  }
}

export function orbColor(node: AgentNode, task?: WorkerTask): string {
  if (node.kind === 'worker') {
    const lane = task?.lane ?? node.worker?.lane;
    return lane === 'agy' ? '#ffb547' : '#2ee6c8';
  }
  const model = (task?.model ?? node.model ?? '').toLowerCase();
  if (model.includes('opus')) return '#d9ccff';
  if (model.includes('sonnet')) return '#2ee6c8';
  if (model.includes('haiku')) return '#b4b1d0';
  if (node.kind === 'main') return '#d9ccff';
  return '#b4b1d0';
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
