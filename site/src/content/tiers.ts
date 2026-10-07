// Routing band per agent. Not in the agent frontmatter, so it lives here (PLAN §8).
// Anything not listed is a domain specialist.
// (Band ids are the globe's layout groups, not routing levels: 't1' is the fast band, kept as an id because the layout code and its checks use it.)
export type Band = 'main' | 'core' | 't1' | 'domain' | 'gate' | 'satellite';

const CORE = ['lead-dev'];
const FAST = ['explore', 'git-specialist', 'junior-dev'];
const GATE = ['security-auditor', 'code-proofreader', 'release-tester', 'test-writer'];

export function bandOf(name: string): Band {
  if (CORE.includes(name)) return 'core';
  if (FAST.includes(name)) return 't1';
  if (GATE.includes(name)) return 'gate';
  if (name === 'showroom' || name.startsWith('showroom-')) return 'satellite';
  return 'domain';
}

// Roster grouping for the Cells chapter, in display order.
export const bandOrder: Band[] = ['core', 't1', 'domain', 'gate', 'satellite'];
export const bandLabels: Record<Band, { title: string; note: string }> = {
  main: { title: 'Main agent', note: 'Your CLI session: does the work itself and delegates.' },
  core: { title: 'Orchestrator', note: 'Optional, for large multi-specialist jobs. Plans and dispatches; does not touch files.' },
  t1: { title: 'Context and fast work', note: 'Read-only context, git, mechanical edits.' },
  domain: { title: 'Domain specialists', note: 'Where large work lands, when its pack is linked.' },
  gate: { title: 'Quality gates', note: 'Review, verify and test.' },
  satellite: { title: 'Showroom', note: 'A coordinator and its workers for scroll-driven product pages.' },
};

/** The main agent: not an agent file but your CLI session running the shared rules, so it is not counted among the agents. It holds the globe's core cell: every task lands
 *  there, is sized up, and is done there or delegated. Copy from ../core/rules/AGENTS.md ("How to work", "Planning", "Delegation") and ../README.md. */
export const MAIN_AGENT = {
  name: 'main agent',
  role: 'Your CLI session',
  tier: 'session',
  band: 'main' as Band,
  pack: 'core',
  description: 'Your CLI session, running the shared rules. It does small and medium work itself, plans large or risky work with you first, and hands wide searches, reviews and domain work to specialists.',
  capabilities: [] as string[],
};
