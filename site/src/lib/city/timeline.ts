// Pure scroll -> run mapping for the City replay. buildTimeline(run) lays the run's beats out over scroll progress
// u in [0, 1] and returns stateAt(u), a pure function that derives every lot's phase from the recorded events.
// Nothing here hardcodes a time: beats open on event predicates, idle gaps are compressed by sqrt(seconds), and
// every present beat gets a minimum share of the runway so none is a flash.
import type { FeaturedRun, RunEvent } from '../run.ts';
import { buildLayout } from './lots.ts';
import { LANES } from './types.ts';
import type {
  ActiveScan, Beat, BeatId, DroneState, ExtraState, Lane, StageCounters, StageState, Timeline, WorkerState,
} from './types.ts';

/** Recommended pinned-scroll runway for the whole replay, in viewport heights. */
export const SCROLL_VH = 500;
/** Fixed shares of the runway: hero (run not started) and bill (run over). */
export const HERO_SHARE = 0.07;
export const BILL_SHARE = 0.09;
/** Minimum share for every present middle beat (task .. review). */
export const MIN_BEAT_SHARE = 0.06;
/** Added to sqrt(gap seconds) per segment so a burst of simultaneous events still gets room to animate. */
const SEGMENT_FLOOR = 2;

const MIDDLE: BeatId[] = ['task', 'plan', 'lanes', 'verify', 'merge', 'review'];

interface Ev {
  e: RunEvent;
  /** Run seconds (or order rank when the run has no timestamps). Non-decreasing in event order. */
  t: number;
  /** Absolute scroll window in which this event animates; it "has happened" from u0 on. */
  u0: number;
  u1: number;
  win?: Window;
}

interface Window { beat: number; t: number; u0: number; u1: number }

export const clamp01 = (x: number) => (x <= 0 || Number.isNaN(x) ? 0 : x >= 1 ? 1 : x);
export const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
/** Progress of u through [a, b]; a step at a when the range is empty. */
const span = (u: number, a: number, b: number) => (b > a ? clamp01((u - a) / (b - a)) : u >= a ? 1 : 0);

export function buildTimeline(run: FeaturedRun): Timeline {
  if (!run || !Array.isArray(run.events) || !Array.isArray(run.workers)) throw new Error('buildTimeline: malformed run');
  const layout = buildLayout(run);

  // --- Events in order, with times. No timestamps anywhere -> order rank stands in for seconds.
  const sorted = run.events.map((e, i) => ({ e, i })).sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i) || a.i - b.i);
  const timed = sorted.length > 0 && sorted.every(({ e }) => typeof e.t === 'number' && Number.isFinite(e.t));
  let last = -Infinity;
  const evs: Ev[] = sorted.map(({ e }, k) => {
    const raw = timed ? (e.t as number) : k;
    last = Math.max(last, raw);
    return { e, t: last, u0: 0, u1: 0 };
  });
  const tStart = evs.length ? evs[0].t : 0;
  const tLast = evs.length ? evs[evs.length - 1].t : 0;
  const tEnd = timed && Number.isFinite(run.wall_s) ? Math.max(tLast, tStart + run.wall_s) : tLast;

  // --- Beat openers (event predicates).
  const first = (pred: (e: RunEvent) => boolean, after = -Infinity) => evs.find((v) => v.t >= after && pred(v.e));
  const firstDispatch = first((e) => e.type === 'dispatch');
  const openers: (Ev | undefined)[] = [
    first((e) => e.type === 'task') ?? evs[0],
    first((e) => e.type === 'plan_mode') ?? first((e) => e.type === 'plan_approved'),
    firstDispatch,
    first((e) => e.type === 'verify' || e.type === 'review' || e.type === 'resume', firstDispatch?.t ?? -Infinity),
    first((e) => e.type === 'merge'),
    first((e) => e.type === 'review' && e.by === 'cross-model'),
  ];
  const doneEv = [...evs].reverse().find((v) => v.e.type === 'done') ?? evs[evs.length - 1];
  const tBill = doneEv ? doneEv.t : tStart;

  // Start times, clamped non-decreasing; absent beats start where the next present one does.
  const present = openers.map((o) => !!o);
  const starts: number[] = new Array(MIDDLE.length);
  let next = tBill;
  for (let b = MIDDLE.length - 1; b >= 0; b--) {
    if (openers[b]) next = Math.min(next, openers[b]!.t);
    starts[b] = next;
  }
  for (let b = 1; b < MIDDLE.length; b++) starts[b] = Math.max(starts[b], starts[b - 1]);
  const endOf = (b: number) => (b + 1 < MIDDLE.length ? starts[b + 1] : tBill);

  // Knots (unique event times) inside each middle beat, and their segment weights.
  const times = [...new Set(evs.map((v) => v.t))];
  const knotsOf = (b: number) => [starts[b], ...times.filter((t) => t > starts[b] && t < endOf(b))];
  const segWeights = (b: number) => {
    const k = knotsOf(b);
    return k.map((t, i) => Math.sqrt(Math.max(0, (i + 1 < k.length ? k[i + 1] : endOf(b)) - t)) + SEGMENT_FLOOR);
  };

  // --- Scroll shares.
  const nPresent = present.filter(Boolean).length;
  const middle = nPresent ? 1 - HERO_SHARE - BILL_SHARE : 0; // no middle beat: the bill takes the rest
  const beatW = MIDDLE.map((_, b) => (present[b] ? segWeights(b).reduce((s, w) => s + w, 0) : 0));
  const sumW = beatW.reduce((s, w) => s + w, 0);
  const free = Math.max(0, middle - nPresent * MIN_BEAT_SHARE);
  const share = MIDDLE.map((_, b) => (present[b] ? MIN_BEAT_SHARE + (sumW > 0 ? (free * beatW[b]) / sumW : free / nPresent) : 0));

  // --- Lay out beats, runTime knots and event windows.
  const beats: Beat[] = [{ id: 'hero', present: true, u0: 0, u1: HERO_SHARE, t0: tStart, t1: tStart }];
  const knotU: number[] = [0, HERO_SHARE];
  const knotT: number[] = [tStart, tStart];
  const windows: Window[] = [];
  let u = HERO_SHARE;
  MIDDLE.forEach((id, b) => {
    const beatIdx = b + 1;
    const u0 = u;
    if (present[b]) {
      const k = knotsOf(b);
      const w = segWeights(b);
      const wSum = w.reduce((s, x) => s + x, 0);
      k.forEach((t, i) => {
        const du = (share[b] * w[i]) / wSum;
        windows.push({ beat: beatIdx, t, u0: u, u1: u + du });
        knotU.push(u);
        knotT.push(t);
        u += du;
      });
      knotU.push(u);
      knotT.push(endOf(b));
    }
    beats.push({ id, present: present[b], u0, u1: u, t0: starts[b], t1: endOf(b) });
  });
  const billU0 = u;
  windows.push({ beat: 7, t: tBill, u0: billU0, u1: 1 });
  knotU.push(billU0, 1);
  knotT.push(tBill, tEnd);
  beats.push({ id: 'bill', present: true, u0: billU0, u1: 1, t0: tBill, t1: tEnd });

  // --- Each event's window: its opener beat if it opens one, else the latest beat that has started by its time.
  const beatStartT = beats.map((bt) => bt.t0);
  for (const v of evs) {
    let beat = openers.indexOf(v) + 1; // 0 when not an opener
    if (v === doneEv) beat = 7;
    if (beat <= 0) {
      beat = 1;
      for (let b = 1; b < beats.length; b++) if (beats[b].present && beatStartT[b] <= v.t) beat = b;
    }
    const inBeat = windows.filter((w) => w.beat === beat);
    const win = [...inBeat].reverse().find((w) => w.t <= v.t) ?? inBeat[0] ?? windows[windows.length - 1];
    v.u0 = win.u0;
    v.u1 = win.u1;
    v.win = win;
  }
  // Scans in one window run one after another; when the window also holds merges, scans take its second half.
  const byWin = new Map<Window, Ev[]>();
  for (const v of evs) {
    const w = v.win!;
    if (!byWin.has(w)) byWin.set(w, []);
    byWin.get(w)!.push(v);
  }
  for (const [w, list] of byWin) {
    const scans = list.filter((v) => v.e.type === 'verify' || v.e.type === 'review');
    if (!scans.length) continue;
    const a = list.some((v) => v.e.type === 'merge') ? 0.5 : 0;
    const len = (w.u1 - w.u0) * (1 - a);
    scans.forEach((v, j) => {
      v.u0 = w.u0 + (w.u1 - w.u0) * a + (len * j) / scans.length;
      v.u1 = v.u0 + len / scans.length;
    });
  }

  // --- Who is who.
  const workerLots = layout.lots.filter((l) => !l.extra);
  const annexLots = layout.lots.filter((l) => l.extra);
  const workerIdx = new Map(workerLots.map((l, i) => [l.slug, i]));
  const extraIdx = new Map(annexLots.map((l, i) => [l.slug, i]));
  const fixerBase = new Map<string, string>();
  for (const w of run.workers) if (w.merged_via) fixerBase.set(w.merged_via, w.slug);
  for (const v of evs) if (v.e.extra && v.e.base && v.e.slug && workerIdx.has(v.e.base)) fixerBase.set(v.e.slug, v.e.base);

  // The worker_done that ends a build/rework started at evs[k] for `slug`.
  const doneAfter = (k: number, slug: string) => {
    for (let j = k + 1; j < evs.length; j++) if (evs[j].e.type === 'worker_done' && evs[j].e.slug === slug) return evs[j];
    return undefined;
  };
  const passEnd = evs.map((v, k) => {
    const e = v.e;
    if (!e.slug || (e.type !== 'dispatch' && e.type !== 'resume')) return v.u1;
    const d = doneAfter(k, e.slug);
    return d && d.u0 > v.u0 ? d.u0 : v.u1;
  });

  const planMode = first((e) => e.type === 'plan_mode');
  const planOk = first((e) => e.type === 'plan_approved');
  const planApproval = run.plan_approval === 'automatic' || run.plan_approval === 'human' ? run.plan_approval : null;
  const taskBeat = beats[1];

  function runTimeAt(uIn: number): number {
    const x = clamp01(uIn);
    for (let i = 1; i < knotU.length; i++) {
      if (x <= knotU[i] || i === knotU.length - 1) {
        const a = knotU[i - 1], b = knotU[i];
        if (b <= a) continue;
        return knotT[i - 1] + (knotT[i] - knotT[i - 1]) * clamp01((x - a) / (b - a));
      }
    }
    return knotT[knotT.length - 1];
  }

  function stateAt(uIn: number): StageState {
    const x = clamp01(uIn);
    const workers: WorkerState[] = workerLots.map((l) => ({
      slug: l.slug, lane: l.lane, phase: 'waiting', build: 0, rework: 0, reworkLane: null, resumes: 0,
      scan: 'none', flag: null, review: 'none', selfCheck: 'none', merge: 0,
    }));
    const extras: ExtraState[] = annexLots.map((l) => ({ slug: l.slug, lane: l.lane, phase: 'waiting', build: 0, merge: 0 }));
    const counters: StageCounters = { dispatched: 0, built: 0, merged: 0, merging: 0, reviewsDone: 0, crossReviewsDone: 0, resumes: 0 };
    let activeScan: ActiveScan = { kind: null, target: null, progress: 0 };
    let planApproved = false;
    const builtSet = new Set<string>();
    const mergedSet = new Set<string>();

    const workerOf = (slug: string | undefined): WorkerState | undefined => {
      if (!slug) return undefined;
      const i = workerIdx.get(slug) ?? workerIdx.get(fixerBase.get(slug) ?? '');
      return i === undefined ? undefined : workers[i];
    };

    evs.forEach((v, k) => {
      if (x < v.u0) return;
      const e = v.e;
      const p = span(x, v.u0, v.u1);
      const isFixer = !!e.slug && fixerBase.has(e.slug);
      const w = workerOf(e.slug);
      const xi = e.slug !== undefined ? extraIdx.get(e.slug) : undefined;
      const xs = xi === undefined ? undefined : extras[xi];
      switch (e.type) {
        case 'plan_approved':
          planApproved = true;
          break;
        case 'dispatch': {
          counters.dispatched++;
          const prog = smooth(span(x, v.u0, passEnd[k]));
          if (isFixer && w) {
            w.phase = 'reworking';
            w.rework = prog;
            w.reworkLane = e.lane ?? w.lane;
          } else if (w) {
            w.phase = 'building';
            w.build = prog;
          } else if (xs) {
            xs.phase = 'building';
            xs.build = prog;
          }
          break;
        }
        case 'resume':
          counters.resumes++;
          if (w) {
            w.resumes++;
            w.phase = 'reworking';
            w.rework = smooth(span(x, v.u0, passEnd[k]));
            w.reworkLane = e.lane ?? w.lane;
          }
          break;
        case 'worker_done':
          if (isFixer && w) {
            w.rework = 1;
            w.reworkLane = null;
            if (w.phase === 'reworking') w.phase = 'built';
          } else if (w) {
            if (!builtSet.has(w.slug)) { builtSet.add(w.slug); counters.built++; }
            w.build = 1;
            if (w.phase === 'reworking') { w.rework = 1; w.reworkLane = null; }
            if (w.phase === 'building' || w.phase === 'reworking' || w.phase === 'waiting') w.phase = 'built';
            if (e.ok === true) w.selfCheck = 'ok';
            else if (e.ok === false) w.selfCheck = 'not-ok';
          } else if (xs) {
            if (!builtSet.has(xs.slug)) { builtSet.add(xs.slug); counters.built++; }
            xs.build = 1;
            if (xs.phase !== 'merging' && xs.phase !== 'merged') xs.phase = 'built';
          }
          break;
        case 'verify':
          if (!w) break;
          if (p < 1) {
            activeScan = { kind: 'verify', target: w.slug, progress: p };
            if (w.scan !== 'flagged' && w.scan !== 'passed') w.scan = 'scanning';
          } else if (e.ok === true) {
            w.scan = 'passed';
            w.flag = null;
          } else if (e.ok === false) {
            w.scan = 'flagged';
            w.flag = 'tests-failed';
          } else {
            w.scan = 'scanning';
            w.flag = null;
          }
          break;
        case 'review': {
          counters.reviewsDone++;
          const cross = e.by === 'cross-model';
          if (cross) counters.crossReviewsDone++;
          const target = cross && !e.slug ? null : (w?.slug ?? null);
          if (!cross && !w) break;
          if (p < 1) {
            activeScan = { kind: cross ? 'cross-model-review' : 'orchestrator-review', target, progress: p };
          } else if (cross) {
            const hit = target === null ? workers.filter((s) => s.phase === 'merged' || s.phase === 'merging') : w ? [w] : [];
            for (const s of hit) s.review = 'cross-model';
          } else if (w && w.review === 'none') {
            w.review = 'orchestrator';
          }
          break;
        }
        case 'merge': {
          const m = smooth(p);
          const t = w ?? xs;
          if (!t) break;
          t.merge = Math.max(t.merge, m);
          t.phase = t.merge >= 1 ? 'merged' : 'merging';
          if (t.build < 1) t.build = 1;
          if (w) { w.reworkLane = null; if (w.rework > 0) w.rework = 1; }
          if (t.merge >= 1 && !mergedSet.has(t.slug)) { mergedSet.add(t.slug); counters.merged++; }
          break;
        }
        default:
          break;
      }
    });

    // Plan: blueprint lines draw over plan_mode -> plan_approved; the plot splits over approval -> first dispatch.
    let blueprint: number;
    let split: number;
    if (planMode || planOk) {
      const a = (planMode ?? planOk)!;
      const b = planOk && planOk.u0 > a.u0 ? planOk.u0 : a.u1;
      blueprint = smooth(span(x, a.u0, b));
      split = planOk
        ? smooth(span(x, planOk.u0, firstDispatch && firstDispatch.u0 > planOk.u0 ? firstDispatch.u0 : planOk.u1))
        : blueprint;
    } else if (firstDispatch) {
      blueprint = split = smooth(span(x, firstDispatch.u0, firstDispatch.u1));
    } else {
      blueprint = split = smooth(span(x, taskBeat.u0, taskBeat.u1));
    }

    const drones: DroneState[] = LANES.map((lane: Lane, i) => ({
      lane,
      used: layout.depots[i].used,
      jobs: [
        ...workers.flatMap((s) =>
          s.phase === 'building' && s.lane === lane ? [{ slug: s.slug, progress: s.build }]
            : s.phase === 'reworking' && s.reworkLane === lane ? [{ slug: s.slug, progress: s.rework }] : []),
        ...extras.flatMap((s) => (s.phase === 'building' && s.lane === lane ? [{ slug: s.slug, progress: s.build }] : [])),
      ],
    }));

    counters.merging = workers.filter((s) => s.phase === 'merging').length + extras.filter((s) => s.phase === 'merging').length;
    const all = [...workers.map((s) => s.merge), ...extras.map((s) => s.merge)];
    const mergeAll = all.length ? all.reduce((s, m) => s + m, 0) / all.length : 0;

    let bi = beats.length - 1;
    for (let b = 0; b < beats.length; b++) {
      if (beats[b].u1 > beats[b].u0 && x >= beats[b].u0 && x < beats[b].u1) { bi = b; break; }
    }
    const beat = beats[bi];
    return {
      u: x,
      runTime: runTimeAt(x),
      beat: beat.id,
      beatProgress: span(x, beat.u0, beat.u1),
      blueprint,
      split,
      planApproved,
      planApproval,
      workers,
      extras,
      activeScan,
      drones,
      mergeAll,
      bill: span(x, beats[7].u0, beats[7].u1),
      counters,
    };
  }

  return { beats, runTimeAt, stateAt };
}

