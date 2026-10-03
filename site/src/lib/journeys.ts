// The journeys the page tells: one per routing example (content/routing.ts), as plain data for the world and for the build-time captions. A journey is the task's route through the swarm:
// the agents it visits on the ground in order (`stops`, after the core that classifies every task), the quality gates it triggers (`gates`, which run in parallel) and its `beats`: the
// steps the page calls out while the comet is at them. Nothing here is invented: it is all read from the routing content.
export interface JourneyStep { label: string; agent?: string }
export interface Tier { id: string; title: string; body: string }

/** One highlighted step. `stop` is the index into the towers the comet rests on (0 = the core, 1 = the first agent after it, ...) or -1 for a gate (the gates are reached together, once the
 *  camera has risen); `k` of `of` is its place among the beats at the same stop (they share that stop's hold). */
export interface Beat { label: string; agent?: string; stop: number; k: number; of: number }

export interface Journey {
  task: string;
  tier: string;
  /** agents visited one after another (everything on the route that is not a gate, in route order) */
  stops: string[];
  /** quality gates the route reaches: they run in parallel */
  gates: string[];
  beats: Beat[];
}

export function journeysOf(examples: { task: string; tier: string; route: JourneyStep[] }[], gateNames: readonly string[], tiers: readonly Tier[]): Journey[] {
  return examples.map((e) => {
    const agents = e.route.flatMap((r) => (r.agent ? [r.agent] : []));
    const stops = agents.filter((a) => !gateNames.includes(a));
    const gates = agents.filter((a) => gateNames.includes(a));
    // the beats: the classification first (at the core), then each step in order; a step with no agent happens where the comet already is
    const raw: Omit<Beat, 'k' | 'of'>[] = [{ label: `Classified: ${tiers.find((t) => t.id === e.tier)?.title ?? e.tier}`, stop: 0 }];
    let at = 0;
    for (const r of e.route) {
      if (r.agent && gateNames.includes(r.agent)) raw.push({ label: r.label, agent: r.agent, stop: -1 });
      else if (r.agent) { at = 1 + stops.indexOf(r.agent); raw.push({ label: r.label, agent: r.agent, stop: at }); }
      else raw.push({ label: r.label, stop: at });
    }
    const beats = raw.map((b) => {
      const same = raw.filter((x) => x.stop === b.stop);
      return { ...b, k: same.indexOf(b), of: same.length };
    });
    return { task: e.task, tier: e.tier, stops, gates, beats };
  });
}

/** The towers the comet visits for a journey: the core first (it classifies the task), then the agents the task goes to; each holds long enough for the beats shown there (`beatSec` each). */
export const walkStopsOf = (j: Journey, core: string, cfg: { coreSec: number; dwellSec: number; beatSec: number }) => {
  const hold = (stop: number, base: number) => Math.max(base, cfg.beatSec * j.beats.filter((b) => b.stop === stop).length);
  return [{ name: core, holdSec: hold(0, cfg.coreSec) }, ...j.stops.map((name, i) => ({ name, holdSec: hold(i + 1, cfg.dwellSec) }))];
};
