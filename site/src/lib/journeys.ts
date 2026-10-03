// The journeys the page tells: one per routing example (content/routing.ts), as plain data for the world and for the build-time captions. A journey is the task's route through the swarm:
// the agents it visits on the ground in order (`stops`, after the core that classifies every task), the quality gates it triggers (`gates`, which run in parallel) and its `beats`: the
// steps the page calls out while the comet is at them. Nothing here is invented: it is all read from the routing content.
export interface JourneyStep { label: string; agent?: string; why?: string }
export interface Tier { id: string; title: string; body: string }

/** One highlighted step. `stop` is the index into the towers the comet rests on (0 = the core, 1 = the first agent after it, ...) or -1 for a gate (the gates are reached together, once the
 *  camera has risen); `k` of `of` is its place among the beats at the same stop (they share that stop's hold). */
export interface Beat {
  label: string; agent?: string; stop: number; k: number; of: number;
  /** the caption's first line: the step as the SwarmKit status line reports it (`> T2 operation: spinning up backend-specialist`) */
  status: string;
  /** the caption's second line: why the step happens (the gates have none of their own: see `gate`) */
  why: string;
}

export interface Journey {
  task: string;
  tier: string;
  /** agents visited one after another (everything on the route that is not a gate, in route order) */
  stops: string[];
  /** quality gates the route reaches: they run in parallel */
  gates: string[];
  beats: Beat[];
  /** the caption shown while the gates run together (none when the route triggers no gate) */
  gate?: { status: string; why: string };
  /** the closing line, once the gates have passed */
  done: string;
}

export function journeysOf(examples: { task: string; tier: string; route: JourneyStep[]; outcome: string }[], gateNames: readonly string[], tiers: readonly Tier[]): Journey[] {
  return examples.map((e) => {
    const agents = e.route.flatMap((r) => (r.agent ? [r.agent] : []));
    const stops = agents.filter((a) => !gateNames.includes(a));
    const gates = agents.filter((a) => gateNames.includes(a));
    // the beats: the classification first (at the core), then each step in order; a step with no agent happens where the comet already is
    const tier = tiers.find((t) => t.id === e.tier);
    const status = (agent?: string) => `> ${e.tier} operation: ${agent ? `spinning up ${agent}` : 'handling inline'}`;
    const need = (r: JourneyStep) => { if (!r.why) throw new Error(`journeys: "${e.task}" step "${r.label}" has no why`); return r.why; };
    const raw: Omit<Beat, 'k' | 'of'>[] = [{ label: `Classified: ${tier?.title ?? e.tier}`, stop: 0, status: `Classified as ${e.tier}: ${tier?.title ?? ''}`, why: tier?.body ?? '' }];
    let at = 0;
    for (const r of e.route) {
      if (r.agent && gateNames.includes(r.agent)) raw.push({ label: r.label, agent: r.agent, stop: -1, status: status(r.agent), why: '' });
      else if (r.agent) { at = 1 + stops.indexOf(r.agent); raw.push({ label: r.label, agent: r.agent, stop: at, status: status(r.agent), why: need(r) }); }
      else raw.push({ label: r.label, stop: at, status: status(), why: need(r) });
    }
    const beats = raw.map((b) => {
      const same = raw.filter((x) => x.stop === b.stop);
      return { ...b, k: same.indexOf(b), of: same.length };
    });
    // the gates run side by side: one caption names them and gives the conditions that triggered them (the steps' labels, "If auth changed" -> "auth changed")
    const because = beats.filter((b) => b.stop < 0).map((b) => b.label.replace(/^If /i, ''));
    const gate = gates.length ? { status: status(gates.join(', ')), why: `${gates.length > 1 ? 'Side by side, because' : 'Because'} ${because.join(' and ')}.` } : undefined;
    return { task: e.task, tier: e.tier, stops, gates, beats, gate, done: e.outcome };
  });
}

/** The towers the comet visits for a journey: the core first (it classifies the task), then the agents the task goes to; each holds long enough for the beats shown there (`beatSec` each). */
export const walkStopsOf = (j: Journey, core: string, cfg: { coreSec: number; dwellSec: number; beatSec: number }) => {
  const hold = (stop: number, base: number) => Math.max(base, cfg.beatSec * j.beats.filter((b) => b.stop === stop).length);
  return [{ name: core, holdSec: hold(0, cfg.coreSec) }, ...j.stops.map((name, i) => ({ name, holdSec: hold(i + 1, cfg.dwellSec) }))];
};
