// Routing story copy. Sources: ../README.md "How it works" and core/rules/AGENTS.md ("How to work", "Planning", "Delegation").
// Agent names used here are validated against ../core/agents at build time (see validateRouting).
import { facts } from '../lib/facts';

/** How much ceremony a task gets. `label` is the short tag (landing buttons, task tags); `title` and `body` are the description. Not in the repo's rules as names: the rules only say what happens to small, large and risky work. */
export const tiers = [
  { id: 'ask', label: 'Question', title: 'Questions', body: 'Answered directly. Listed in the table only: no example task is a question.' },
  { id: 'direct', label: 'Direct', title: 'Small and medium work', body: 'The main agent does it itself: no plan, no approval.' },
  { id: 'planned', label: 'Planned', title: 'Large or risky work', body: 'More than about 3 files, or auth, data, CI or infra: you approve a plan first.' },
  { id: 'orchestrated', label: 'Orchestrated', title: 'Multi-specialist jobs', body: 'Optional: lead-dev plans and dispatches specialists, in an isolated git worktree.' },
] as const;

export const gates = [
  { agent: 'security-auditor', when: 'auth, secrets or input handling changed' },
  { agent: 'code-proofreader', when: 'the diff is large' },
  { agent: 'release-tester', when: 'tests were not run' },
] as const;

/** `why` is the one-line reason shown while the walk is at the step (the quality gates have none: their reason is the condition in their label). `outcome` closes the walk. */
export interface RouteStep { label: string; agent?: string; why?: string; /** the caption's first line when the step has no agent (default: the main agent handles it) */ status?: string }
export type TierId = (typeof tiers)[number]['id'];
export const tierLabel = (id: TierId) => tiers.find((t) => t.id === id)!.label;
export interface ExampleTask { task: string; tier: TierId; route: RouteStep[]; outcome: string }

export const examples: ExampleTask[] = [
  {
    task: 'Fix a typo',
    tier: 'direct',
    route: [
      { label: 'Edit directly', why: 'The main agent makes the edit itself.' },
      { label: 'No plan, no gate', why: 'There is no plan to approve and no review to run.' },
    ],
    outcome: 'Done, nothing else needed. Back to you.',
  },
  {
    task: 'Add an API route',
    tier: 'planned',
    route: [
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Implement', agent: 'backend-specialist', why: 'With the backend pack linked, its specialist writes the code; otherwise the main agent does.' },
      { label: 'If input handling changed', agent: 'security-auditor' },
      { label: 'If tests were not run', agent: 'release-tester' },
    ],
    outcome: 'Planned, built, checked. Back to you.',
  },
  {
    task: 'Refactor auth',
    tier: 'orchestrated',
    route: [
      { label: 'Optional: lead-dev, in a worktree', status: 'Orchestrator: lead-dev', why: 'Started with claude --agent lead-dev (swarm pack): it dispatches and works in .worktrees/<branch>.' },
      { label: 'If the codebase is unfamiliar', agent: 'explore', why: 'The codebase is unfamiliar, so it is mapped before anything is planned.' },
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Implement', agent: 'backend-specialist', why: 'With its pack linked, the domain specialist writes the code; otherwise the main agent does.' },
      { label: 'If auth changed', agent: 'security-auditor' },
      { label: 'If the diff is large', agent: 'code-proofreader' },
    ],
    outcome: 'Mapped, planned, built, checked. Back to you.',
  },
  {
    task: 'Build a product page',
    tier: 'planned',
    route: [
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Hand off to Showroom', agent: 'showroom', why: 'The coordinator keeps the pipeline and gates; a subagent cannot start others, so it returns handoffs.' },
      { label: 'Brief (G1)', agent: 'showroom-intake', why: 'Dispatched from the handoff: one batch of questions about the product, then it waits for your answers.' },
      { label: 'Tokens and assets (G2, G3)', agent: 'showroom-art-director', why: 'Dispatched from the next handoff: design tokens and an asset request pack, each approved by you.' },
      { label: 'Sections (G4)', agent: 'showroom-frontend-builder', why: 'Dispatched from the handoff: the page is built section by section in Astro and Tailwind.' },
      { label: 'Scroll motion', agent: 'showroom-motion-engineer', why: 'Dispatched from the handoff: GSAP and Lenis motion, with a reduced-motion path.' },
    ],
    outcome: 'Briefed, designed, built, animated. Back to you.',
  },
];

/** The order the page tells the tasks in when nobody picks one: the first loop flies to the moon, each loop after it tells the next (world.ts, at the wrap). */
export const tellingOrder = ['Build a product page', 'Add an API route', 'Refactor auth', 'Fix a typo'];
for (const t of tellingOrder) if (!examples.some((e) => e.task === t)) throw new Error(`routing.ts tellingOrder names unknown task "${t}"`);

const names = new Set(facts.agents.map((a) => a.name));
for (const n of ['explore', ...gates.map((g) => g.agent), ...examples.flatMap((e) => e.route.flatMap((r) => (r.agent ? [r.agent] : [])))]) {
  if (!names.has(n)) throw new Error(`routing.ts references unknown agent "${n}"`);
}
