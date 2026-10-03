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

/** `why` is the one-line reason shown while the walk is at the step (the quality gates have none: their reason is the condition in their label). `outcome` closes the walk. */
export interface RouteStep { label: string; agent?: string; why?: string }
export interface ExampleTask { task: string; tier: string; route: RouteStep[]; outcome: string }

export const examples: ExampleTask[] = [
  {
    task: 'Fix a typo',
    tier: 'T1',
    route: [
      { label: 'Edit directly', why: 'A trivial edit is made on the spot.' },
      { label: 'No plan, no gate', why: 'There is no plan to approve and no check to pass.' },
    ],
    outcome: 'Done, nothing else needed. Back to you.',
  },
  {
    task: 'Add an API route',
    tier: 'T2',
    route: [
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Implement', agent: 'backend-specialist', why: 'The domain specialist writes the code.' },
      { label: 'If input handling changed', agent: 'security-auditor' },
      { label: 'If tests were not run', agent: 'release-tester' },
    ],
    outcome: 'Planned, built, checked. Back to you.',
  },
  {
    task: 'Refactor auth',
    tier: 'T3',
    route: [
      { label: 'Isolated worktree', why: 'The work happens in a separate git worktree, away from your branch.' },
      { label: 'If the codebase is unfamiliar', agent: 'explore', why: 'The codebase is unfamiliar, so it is mapped before anything is planned.' },
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Implement', agent: 'backend-specialist', why: 'The domain specialist writes the code.' },
      { label: 'If auth changed', agent: 'security-auditor' },
      { label: 'If the diff is large', agent: 'code-proofreader' },
    ],
    outcome: 'Mapped, planned, built, checked. Back to you.',
  },
  {
    task: 'Build a product page',
    tier: 'T2',
    route: [
      { label: 'Plan and approval', why: 'Nothing is built until you approve the plan.' },
      { label: 'Hand off to Showroom', agent: 'showroom', why: 'Product pages have a swarm of their own on the moon: a pipeline with your approval at each gate.' },
      { label: 'Brief (G1)', agent: 'showroom-intake', why: 'One batch of questions about the product, then it waits for your answers.' },
      { label: 'Tokens and assets (G2, G3)', agent: 'showroom-art-director', why: 'Design tokens and an asset request pack, each approved by you.' },
      { label: 'Sections (G4)', agent: 'showroom-frontend-builder', why: 'The page is built section by section in Astro and Tailwind.' },
      { label: 'Scroll motion', agent: 'showroom-motion-engineer', why: 'GSAP and Lenis motion, with a reduced-motion path.' },
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
