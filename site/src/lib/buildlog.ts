// Summarises .buildlog/*.jsonl for the Proof timeline. Counts are real; nothing is padded.
//
// "Human interventions" counts ONLY things the human did themselves:
//   - gate approvals: human.jsonl entries with type "gate";
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

export function loadBuildlog() {
  const dispatch = read('dispatch.jsonl');
  const human = read('human.jsonl');
  const art = read('artdirection.jsonl');

  const dispatchesByAgent = new Map<string, number>();
  for (const d of dispatch) dispatchesByAgent.set(str(d.agent_type), (dispatchesByAgent.get(str(d.agent_type)) ?? 0) + 1);

  const rounds = new Map<number, Row[]>();
  for (const a of art) rounds.set(Number(a.round), [...(rounds.get(Number(a.round)) ?? []), a]);

  const byHuman = (h: Row) => h.actor !== 'agent';
  const gates = human.filter((h) => h.type === 'gate' && byHuman(h)).length;
  const decisions = human.filter((h) => h.type === 'decision' && byHuman(h)).length;
  const humanRounds = [...rounds.entries()].filter(([, rows]) => rows.some((r) => !AGENT_APPLIED.has(str(r.verdict)))).length;
  const agentLogged = human.filter((h) => h.actor === 'agent').length;

  const events: TimelineEvent[] = [
    ...human.map((h) => ({
      ts: str(h.ts),
      actor: byHuman(h) ? ('human' as const) : ('agent' as const),
      kind: str(h.type),
      text: h.type === 'measurement' ? `Phase ${h.phase} frame rate reported by the human` : str(h.note) || str(h.verdict),
    })),
    ...[...rounds.entries()].flatMap(([round, rows]) => {
      const verdicts = rows.filter((r) => !AGENT_APPLIED.has(str(r.verdict)));
      const applied = rows.length - verdicts.length;
      const ts = str(rows[0].ts);
      return [
        ...(verdicts.length ? [{ ts, actor: 'human' as const, kind: 'art direction', text: `Round ${round}: ${verdicts.length} ${verdicts.length === 1 ? 'verdict' : 'verdicts'} from the human` }] : []),
        ...(applied ? [{ ts, actor: 'agent' as const, kind: 'art direction', text: `Round ${round}: ${applied} ${applied === 1 ? 'change' : 'changes'} applied by the agent` }] : []),
      ];
    }),
    ...dispatch.map((d) => ({ ts: str(d.ts), actor: 'agent' as const, kind: 'dispatch', text: `${str(d.agent_type)} finished a task` })),
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
