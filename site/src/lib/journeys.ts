// The journeys the page tells: one per routing example (content/routing.ts), as plain data for the world. A journey is the task's route through the swarm:
// the agents it visits on the ground in order (`stops`, after the core that classifies every task) and the quality gates it triggers, which run in parallel (`gates`).
// Steps with no agent ("Plan and approval", "Edit directly") stay in `steps` as captions. Nothing here is invented: it is all read from the routing content.
export interface JourneyStep { label: string; agent?: string }
export interface Journey {
  slug: string;
  task: string;
  tier: string;
  steps: JourneyStep[];
  /** agents visited one after another (everything on the route that is not a gate, in route order) */
  stops: string[];
  /** quality gates the route reaches: they run in parallel */
  gates: string[];
}

export const slugOf = (task: string) => task.toLowerCase().replace(/\s+/g, '-');

export function journeysOf(examples: { task: string; tier: string; route: JourneyStep[] }[], gateNames: readonly string[]): Journey[] {
  return examples.map((e) => {
    const agents = e.route.flatMap((r) => (r.agent ? [r.agent] : []));
    return { slug: slugOf(e.task), task: e.task, tier: e.tier, steps: e.route, stops: agents.filter((a) => !gateNames.includes(a)), gates: agents.filter((a) => gateNames.includes(a)) };
  });
}

/** The towers the walker visits for a journey: the core first (it classifies the task and holds for `coreHoldSec`), then the agents the task goes to on the ground. */
export const walkStopsOf = (j: Journey, core: string, coreHoldSec: number) => [{ name: core, holdSec: coreHoldSec }, ...j.stops.map((name) => ({ name }))];
