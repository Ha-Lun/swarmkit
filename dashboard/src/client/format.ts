// Small pure formatting helpers. No side effects, no React.
import type { AgentNode, PermissionRequest, WorkerTask } from '../shared/types';

/** 'claude-opus-5-5' -> 'Opus 5.5'; 'opencode-go/glm-5.3-flash' -> 'glm-5.3-flash'; missing -> ''. */
export function modelLabel(model?: string): string {
  if (!model) return '';
  const m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(model);
  if (m) return `${cap(m[1])} ${m[2]}.${m[3]}`;
  if (/^(opus|sonnet|haiku)$/.test(model)) return cap(model);
  return shortModel(model);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** 6s / 2m 14s / 1h 3m */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** $0.08; <$0.01 when tiny; $0.00 when zero. */
export function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** 'just now' / '5m ago' / '2h ago' / '3d ago' */
export function relTime(ts: number, now: number): string {
  const d = Math.max(0, now - ts);
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}

/** 12:03:45 for timeline entries. */
export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** 980 / 12k / 3.4M */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export type ToolKey = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'agent' | 'other';

const TOOL_GROUPS: Array<[ToolKey, string[]]> = [
  ['read', ['Read']],
  ['edit', ['Edit', 'Write', 'NotebookEdit']],
  ['bash', ['Bash']],
  ['search', ['Grep', 'Glob', 'LS']],
  ['web', ['WebFetch', 'WebSearch']],
  ['agent', ['Task', 'Agent']],
];

/** Collapse raw tool counts into the icon groups shown on a card. */
export function toolGroups(counts: Record<string, number>): Array<{ key: ToolKey; count: number }> {
  const out: Array<{ key: ToolKey; count: number }> = [];
  const seen = new Set<string>();
  for (const [key, names] of TOOL_GROUPS) {
    let count = 0;
    for (const name of names) {
      count += counts[name] ?? 0;
      seen.add(name);
    }
    if (count > 0) out.push({ key, count });
  }
  let other = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (!seen.has(name)) other += count;
  }
  if (other > 0) out.push({ key: 'other', count: other });
  return out;
}

/** The line under a permission request: title sentence, else the most telling input field. */
export function permissionSummary(p: PermissionRequest): string {
  if (p.title) return p.title;
  const input = p.input ?? {};
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  try {
    return JSON.stringify(input).slice(0, 160);
  } catch {
    return p.tool;
  }
}

/** Elapsed time for a card footer. */
export function elapsedMs(node: AgentNode, now: number): number {
  if (node.status === 'running' || node.status === 'waiting') return now - node.startedAt;
  return (node.endedAt ?? now) - node.startedAt;
}

/** 'opencode-go/glm-5.3-flash' -> 'glm-5.3-flash'; missing -> ''. */
export function shortModel(model?: string): string {
  if (!model) return '';
  const i = model.lastIndexOf('/');
  return i >= 0 ? model.slice(i + 1) : model;
}

/** Worker state -> the shared dot/status classes (running pulse / ok green / not-ok red / unfinished gray). */
export function workerStateClass(state: WorkerTask['state']): string {
  switch (state) {
    case 'running':
      return 'st-running';
    case 'ok':
      return 'st-done';
    case 'not-ok':
      return 'st-error';
    default:
      return 'st-idle';
  }
}

/** Ticking seconds for a worker task: server elapsed + seconds since the update arrived. */
export function workerElapsedS(task: WorkerTask, now: number, at: number): number {
  if (task.state !== 'running' || at === 0) return task.elapsedS;
  return task.elapsedS + Math.max(0, Math.floor((now - at) / 1000));
}

export const UNTRUSTED_NOTICE =
  'Untrusted folder: project settings and hooks are ignored. Open it once in Claude Code in a terminal to trust it.';
