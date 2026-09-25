// Routing story copy. Sources: ../README.md "How it works" and core/rules/AGENTS.md "Routing".
// Agent names used here are validated against ../core/agents at build time (see validateRouting).
import { facts } from '../lib/facts';

export const tiers = [
  { id: 'T0', title: 'Questions and reviews', body: 'Answered directly.' },
  { id: 'T1', title: 'Trivial edits', body: 'Typos, renames, version bumps. Done directly, with no plan and no gate.' },
  { id: 'T2', title: 'Contained domain work', body: 'Plan, your approval, then execution by the domain specialist.' },
  { id: 'T3', title: 'Cross-cutting work', body: 'Same as T2, in an isolated git worktree.' },
] as const;

export const gates = [
  { agent: 'security-auditor', when: 'auth, secrets or input handling changed' },
  { agent: 'code-proofreader', when: 'the diff is large' },
  { agent: 'release-tester', when: 'tests were not run' },
] as const;

export interface RouteStep { label: string; agent?: string }
export interface ExampleTask { task: string; tier: string; route: RouteStep[] }

export const examples: ExampleTask[] = [
  {
    task: 'Fix a typo',
    tier: 'T1',
    route: [{ label: 'Edit directly' }, { label: 'No plan, no gate' }],
  },
  {
    task: 'Add an API route',
    tier: 'T2',
    route: [
      { label: 'Plan and approval' },
      { label: 'Implement', agent: 'backend-specialist' },
      { label: 'If input handling changed', agent: 'security-auditor' },
      { label: 'If tests were not run', agent: 'release-tester' },
    ],
  },
  {
    task: 'Refactor auth',
    tier: 'T3',
    route: [
      { label: 'Isolated worktree' },
      { label: 'If the codebase is unfamiliar', agent: 'explore' },
      { label: 'Plan and approval' },
      { label: 'Implement', agent: 'backend-specialist' },
      { label: 'If auth changed', agent: 'security-auditor' },
      { label: 'If the diff is large', agent: 'code-proofreader' },
    ],
  },
];

const names = new Set(facts.agents.map((a) => a.name));
for (const n of ['explore', ...gates.map((g) => g.agent), ...examples.flatMap((e) => e.route.flatMap((r) => (r.agent ? [r.agent] : [])))]) {
  if (!names.has(n)) throw new Error(`routing.ts references unknown agent "${n}"`);
}
