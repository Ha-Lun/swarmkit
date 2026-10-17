// Summarises .buildlog/*.jsonl for the Proof timeline. Counts are real; nothing is padded.
//
// "Human interventions" counts ONLY things the human did themselves:
//   - gate approvals: human.jsonl entries with type "gate", or with a "gate" field (the merge approvals are logged that way);
//   - decisions: human.jsonl entries with type "decision" (the human's plan approvals and answers to questions),
//     unless the entry carries actor "agent" (a call the agent logged as its own);
//   - art-direction rounds in which the human gave at least one verdict. An artdirection.jsonl row is an
//     agent-applied placeholder, not a verdict, when its verdict is "apply proposal" or "pending human check".
// Excluded: type "measurement" (housekeeping, figures the human relayed), agent-authored entries, and every
// agent-applied art-direction row. The page shows the same breakdown, so the total always equals its parts.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = Record<string, unknown>;
const AGENT_APPLIED = new Set(['apply proposal', 'pending human check']);
export type Actor = 'human' | 'agent';
export interface TimelineEvent { ts: string; actor: Actor; kind: string; text: string }

function read(name: string): Row[] {
  const file = resolve(process.cwd(), '.buildlog', name);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Row);
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

// Curated allowlisted labels for the public timeline. Only structured fields.
function sanitizeLabel(s: string): string {
  const noUrls = s.replace(/https?:\/\/\S+/gi, ' ');
  const tokens = noUrls.split(/\s+/).filter((t) => t && !t.includes('/') && !t.includes('@'));
  const joined = tokens.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 90 ? joined.slice(0, 90).trim() : joined;
}

export function publicLabel(row: Row, source: 'human' | 'art' | 'dispatch'): string | null {
  let raw: string | null = null;
  if (source === 'human') {
    const gate = str(row.gate);
    if (gate) {
      const verdict = str(row.verdict).toLowerCase();
      if (verdict && verdict !== 'approved') return null;
      raw = `Gate approved: ${gate}`;
    } else if (row.type === 'decision') {
      raw = 'Decision recorded';
    } else {
      return null;
    }
  } else if (source === 'art') {
    const roundNum = Number(row.round);
    const element = str(row.element);
    if (!Number.isFinite(roundNum) || !element) return null;
    const roundStr = Number.isInteger(roundNum) ? String(roundNum) : String(row.round);
    raw = `Art-direction round ${roundStr}: ${element.slice(0, 70)}`;
  } else {
    const name = str(row.agent_type) || str(row.agent);
    if (!name) return null;
    raw = `${name} dispatched`;
  }
  const clean = sanitizeLabel(raw);
  if (!clean) return null;
  return clean;
}

// Older dispatch rows name the subagent `agent_type`, newer hand-written ones `agent`. A row with a `lane` went to a
// headless worker (agy or opencode), not to a Claude subagent.
const subagentName = (d: Row) => str(d.agent_type) || str(d.agent) || 'unnamed';

export function loadBuildlog() {
  return summarizeBuildlog(read('dispatch.jsonl'), read('human.jsonl'), read('artdirection.jsonl'));
}

export function summarizeBuildlog(allDispatch: Row[], human: Row[], art: Row[]) {
  const dispatch = allDispatch.filter((d) => !d.lane);

  const dispatchesByAgent = new Map<string, number>();
  for (const d of dispatch) dispatchesByAgent.set(subagentName(d), (dispatchesByAgent.get(subagentName(d)) ?? 0) + 1);

  const rounds = new Map<number, Row[]>();
  for (const a of art) rounds.set(Number(a.round), [...(rounds.get(Number(a.round)) ?? []), a]);

  const byHuman = (h: Row) => h.actor !== 'agent';
  const gates = human.filter((h) => (h.type === 'gate' || (h.type === undefined && 'gate' in h)) && byHuman(h)).length;
  const decisions = human.filter((h) => h.type === 'decision' && byHuman(h)).length;
  const humanRounds = [...rounds.entries()].filter(([, rows]) => rows.some((r) => !AGENT_APPLIED.has(str(r.verdict)))).length;
  const agentLogged = human.filter((h) => h.actor === 'agent').length;

  const events: TimelineEvent[] = [
    ...human.flatMap((h) => {
      const label = publicLabel(h, 'human');
      if (!label) return [];
      return [{ ts: str(h.ts), actor: byHuman(h) ? ('human' as const) : ('agent' as const), kind: str(h.type), text: label }];
    }),
    ...art.flatMap((a) => {
      const label = publicLabel(a, 'art');
      if (!label) return [];
      return [{ ts: str(a.ts), actor: AGENT_APPLIED.has(str(a.verdict)) ? ('agent' as const) : ('human' as const), kind: 'art direction', text: label }];
    }),
    ...dispatch.flatMap((d) => {
      const label = publicLabel(d, 'dispatch');
      if (!label) return [];
      return [{ ts: str(d.ts), actor: 'agent' as const, kind: 'dispatch', text: label }];
    }),
  ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  return {
    dispatches: dispatch.length,
    dispatchesByAgent: [...dispatchesByAgent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    gates,
    decisions,
    artRounds: humanRounds,
    agentLogged,
    interventions: gates + decisions + humanRounds,
    events,
  };
}

export interface WorkerSummary {
  tasks: number;
  byLane: Record<string, number>;
  models: string[];
  /** finished tasks whose row names a model (older rows predate the field) */
  modelRecorded: number;
  stopped: number;
  denied: number;
}

// Pure summary over worker dispatch log rows. Only rows with event === 'finish'
// or with no event field count as finished tasks (event === 'start' rows are
// dispatches, not completions). Every field after that is read off the finished
// rows only: lane from row.cli, distinct row.model values, non-null stopped_by,
// and the sum of row.denied.
export function summarizeWorkers(rows: Array<Record<string, unknown>>): WorkerSummary {
  const finished = rows.filter((r) => r.event === undefined || r.event === 'finish');
  const byLane: Record<string, number> = {};
  const modelSet = new Set<string>();
  let modelRecorded = 0;
  let stopped = 0;
  let denied = 0;
  for (const r of finished) {
    if (typeof r.cli === 'string' && r.cli) byLane[r.cli] = (byLane[r.cli] ?? 0) + 1;
    if (typeof r.model === 'string' && r.model) { modelSet.add(r.model); modelRecorded += 1; }
    if (r.stopped_by != null) stopped += 1;
    const d = Number(r.denied);
    if (Number.isFinite(d)) denied += d;
  }
  return { tasks: finished.length, byLane, models: [...modelSet].sort(), modelRecorded, stopped, denied };
}

// Reads .buildlog/workers.jsonl the same way read() does (missing file -> []).
export function loadWorkerLog(): WorkerSummary {
  return summarizeWorkers(read('workers.jsonl'));
}
