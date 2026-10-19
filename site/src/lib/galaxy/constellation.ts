// Pure constellation layout and line-draw schedule. Positions are in the world space around the core, in the plane
// the final camera looks into. Opencode workers form the left cluster, agy the right, so lanes read at a glance.
import { clamp01 } from './path.ts';
import type { V3 } from './path.ts';

export type Lane = 'opencode' | 'agy';
export interface NodeSpec { slug: string; lane: Lane; pos: V3 }

/** aspect = viewport width / height. Portrait stacks the lanes top and bottom. */
export function layoutNodes(workers: { slug: string; lane: Lane }[], aspect: number): NodeSpec[] {
  const wide = aspect >= 1.1;
  const lanes: Lane[] = ['opencode', 'agy'];
  const out: NodeSpec[] = [];
  for (let li = 0; li < lanes.length; li++) {
    const group = workers.filter((w) => w.lane === lanes[li]);
    group.forEach((w, k) => {
      const f = group.length > 1 ? k / (group.length - 1) : 0.5; // 0..1 along the arc
      let x: number;
      let y: number;
      let z: number;
      if (wide) {
        const ang = ((li === 0 ? 180 : 0) + (f - 0.5) * 118) * (Math.PI / 180);
        x = Math.cos(ang) * 1.6;
        y = Math.sin(ang) * 1.0;
        z = ((k % 2) - 0.5) * 0.7 + (li ? 0.15 : -0.1);
      } else {
        const ang = ((li === 0 ? 90 : 270) + (f - 0.5) * 104) * (Math.PI / 180);
        x = Math.cos(ang) * 0.95;
        y = Math.sin(ang) * 1.0;
        z = ((k % 2) - 0.5) * 0.5;
      }
      out.push({ slug: w.slug, lane: lanes[li], pos: [x, y, z] });
    });
  }
  // keep the run's original order for DOM/aria
  return workers.map((w) => out.find((n) => n.slug === w.slug)!);
}

/** Line i (0..n-1) is the Opus -> node spoke. 0..1 draw progress at overall draw d. */
export function spokeProgress(d: number, i: number, n: number): number {
  const stagger = 0.5 / Math.max(1, n);
  const start = i * stagger;
  return clamp01((d - start) / 0.5);
}
/** Ring links (node i -> next node in the same lane), drawn after the spokes. */
export function linkProgress(d: number): number {
  return clamp01((d - 0.72) / 0.28);
}
/** A node lights when its spoke is nearly there. */
export function nodeOn(d: number, i: number, n: number): number {
  return clamp01((spokeProgress(d, i, n) - 0.82) / 0.18);
}
