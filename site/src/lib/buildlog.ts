// Summarises .buildlog/*.jsonl for the Proof timeline. Counts are real; nothing is padded.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = Record<string, unknown>;
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

  const gates = human.filter((h) => h.type === 'gate').length;
  const decisions = human.filter((h) => h.type === 'decision').length;

  const events: TimelineEvent[] = [
    ...human.map((h) => ({
      ts: str(h.ts),
      actor: 'human' as const,
      kind: str(h.type),
      text: h.type === 'measurement' ? `Phase ${h.phase} frame rate reported by the human` : str(h.note) || str(h.verdict),
    })),
    ...[...rounds.entries()].map(([round, rows]) => ({
      ts: str(rows[0].ts),
      actor: 'human' as const,
      kind: 'art direction',
      text: `Round ${round}: ${rows.length} ${rows.length === 1 ? 'change' : 'changes'} reviewed`,
    })),
    ...dispatch.map((d) => ({ ts: str(d.ts), actor: 'agent' as const, kind: 'dispatch', text: `${str(d.agent_type)} finished a task` })),
  ].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  return {
    dispatches: dispatch.length,
    dispatchesByAgent: [...dispatchesByAgent.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    gates,
    decisions,
    artRounds: rounds.size,
    interventions: gates + decisions + rounds.size,
    events,
  };
}
