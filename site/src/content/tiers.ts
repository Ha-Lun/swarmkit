// Routing band per agent. Not in the agent frontmatter, so it lives here (PLAN §8).
// Anything not listed is a domain specialist.
export type Band = 'core' | 't1' | 'domain' | 'gate' | 'satellite';

const CORE = ['lead-dev'];
const T1 = ['explore', 'git-specialist', 'junior-dev'];
const GATE = ['security-auditor', 'code-proofreader', 'release-tester', 'test-writer'];

export function bandOf(name: string): Band {
  if (CORE.includes(name)) return 'core';
  if (T1.includes(name)) return 't1';
  if (GATE.includes(name)) return 'gate';
  if (name === 'showroom' || name.startsWith('showroom-')) return 'satellite';
  return 'domain';
}

// Roster grouping for the Cells chapter, in display order.
export const bandOrder: Band[] = ['core', 't1', 'domain', 'gate', 'satellite'];
export const bandLabels: Record<Band, { title: string; note: string }> = {
  core: { title: 'Core', note: 'Plans and dispatches. Does not touch files.' },
  t1: { title: 'Context and fast work', note: 'Read-only context, git, mechanical edits.' },
  domain: { title: 'Domain specialists', note: 'Where T2 and T3 work lands.' },
  gate: { title: 'Quality gates', note: 'Review, verify and test.' },
  satellite: { title: 'Showroom', note: 'A coordinator and its workers for scroll-driven product pages.' },
};
