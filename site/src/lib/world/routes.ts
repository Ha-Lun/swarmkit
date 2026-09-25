import { CatmullRomCurve3, Vector3, type Camera } from 'three';
import { look } from './config';
import { motion } from './motion-config';
import { createPacket, type Packet } from './packet';
import type { Lattice } from './honeycomb';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * An open route for the packet. Packet.update walks the curve backwards from `phase` with a modulo, so a
 * plain open curve would wrap its tail to the far end. This curve reserves the first `trailLength` of the
 * parameter for a collapsed lead-in (every point = route start): the trail grows out of the start and
 * shrinks into the end instead of wrapping. Route progress r in 0..1 maps to phase T + r * (1 - T).
 */
export class RouteCurve extends CatmullRomCurve3 {
  private readonly lead = look.packet.trailLength;
  constructor() {
    super([new Vector3(), new Vector3(0, 0, 1)], false, 'centripetal');
  }
  setRoute(points: Vector3[]) {
    this.points = points;
    this.updateArcLengths();
  }
  override getPointAt(u: number, target?: Vector3): Vector3 {
    return super.getPointAt(clamp01((u - this.lead) / (1 - this.lead)), target);
  }
  phase(r: number) {
    return this.lead + clamp01(r) * (1 - this.lead);
  }
}

export interface Flow {
  packet: Packet;
  curve: RouteCurve;
  /** route length in world units */
  setRoute(points: Vector3[]): number;
  /** draw the packet at route progress r with brightness fade 0..1 */
  set(r: number, camera: Camera, fade: number): void;
  hide(): void;
  dispose(): void;
}

export function createFlow(accent: string): Flow {
  const curve = new RouteCurve();
  const cfg = { ...look.packet };
  const packet = createPacket(curve, accent, cfg);
  packet.group.visible = false;
  return {
    packet,
    curve,
    setRoute(points) {
      curve.setRoute(points);
      return curve.getLength();
    },
    set(r, camera, fade) {
      cfg.headBrightness = look.packet.headBrightness * fade;
      packet.group.visible = fade > 0.003;
      if (packet.group.visible) packet.update(curve.phase(r), camera, cfg);
    },
    hide() {
      packet.group.visible = false;
    },
    dispose: () => packet.dispose(),
  };
}

/** Head position (world) at progress r. */
export function headAt(flow: Flow, r: number, out: Vector3): Vector3 {
  flow.curve.getPointAt(flow.curve.phase(r), out);
  out.y += look.packet.height;
  return out;
}

/** Off-lattice point where a task packet comes in from, derived from the lattice radius. */
export function entryPoint(lattice: Lattice, out = new Vector3()): Vector3 {
  return out.set(-0.95 * lattice.radius, motion.packet.entryHeight, 0.5 * lattice.radius);
}

/** Insert a raised midpoint between consecutive stops so the packet hops over intermediate cells. */
export function withArcs(stops: Vector3[]): Vector3[] {
  const out: Vector3[] = [stops[0].clone()];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += motion.packet.arcLift + motion.packet.arcLiftPerUnit * a.distanceTo(b);
    out.push(mid, b.clone());
  }
  return out;
}

/** Route progress (0..1) at which the curve passes closest to each stop, searched forward so order is kept. */
export function stopProgress(curve: RouteCurve, stops: Vector3[], samples = 240): number[] {
  const p = new Vector3();
  const res: number[] = [];
  let from = 0;
  for (const s of stops) {
    let best = from, bestD = Infinity;
    for (let i = from; i <= samples; i++) {
      curve.getPointAt(curve.phase(i / samples), p);
      const d = p.distanceToSquared(s);
      if (d < bestD) { bestD = d; best = i; }
    }
    res.push(best / samples);
    from = best;
  }
  return res;
}

export interface Timeline {
  total: number;
  /** seconds at which the packet arrives at each stop */
  arrivals: number[];
  rAt(t: number): number;
}

/** Piecewise-linear r(t): travel at `speed` (units/s) between stops, pause `dwell` seconds at each. */
export function makeTimeline(length: number, stops: number[], speed: number, dwell: number[]): Timeline {
  const knots: { t: number; r: number }[] = [{ t: 0, r: 0 }];
  const arrivals: number[] = [];
  let t = 0, r = 0;
  const targets = stops.length && stops[stops.length - 1] >= 0.999 ? stops : [...stops, 1];
  targets.forEach((s, i) => {
    t += ((s - r) * length) / speed;
    r = s;
    knots.push({ t, r });
    if (i < stops.length) arrivals.push(t);
    const d = dwell[i] ?? 0;
    if (d > 0) { t += d; knots.push({ t, r }); }
  });
  return {
    total: t,
    arrivals,
    rAt(x) {
      if (x <= 0) return 0;
      for (let i = 1; i < knots.length; i++) {
        if (x <= knots[i].t) {
          const a = knots[i - 1], b = knots[i];
          return b.t === a.t ? b.r : a.r + ((b.r - a.r) * (x - a.t)) / (b.t - a.t);
        }
      }
      return 1;
    },
  };
}
