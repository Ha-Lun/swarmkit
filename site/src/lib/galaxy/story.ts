import type { FeaturedRun, Lane } from '../run.ts';

export interface StoryWorker {
  slug: string;
  lane: Lane; // RunWorker.lane
  launchIndex: number; // 0-based order of this worker's FIRST 'dispatch' event (by event.order)
  buildIndex: number; // 0-based order of its FIRST 'worker_done' event (workers with none come last, in launch order)
  failedVerifies: number; // count of 'verify' events for this slug with ok === false
  resumes: number; // RunWorker.resumes: how many times the orchestrator resumed this worker
  failed: boolean; // failedVerifies > 0 (ONLY real failing tests count; RunWorker.ok=false means a denied command, NOT failure)
  fixer: { slug: string; lane: Lane } | null; // from RunWorker.merged_via + that slug's dispatch event lane; null if none
  reviewed: boolean; // at least one 'review' event for this slug
  reviewedBy: 'cross-model' | 'orchestrator' | null; // 'cross-model' if any review for it has by === 'cross-model', else 'orchestrator' if any review, else null
  mergeIndex: number | null; // 0-based order among 'merge' events of the merge that landed its work (its own slug, or its fixer's slug); null if never merged
}

export interface Story {
  task: string; // run.task
  label: string; // run.label (e.g. "One real run, not a median")
  workers: StoryWorker[]; // in launchIndex order
  lanes: Lane[]; // distinct lanes used, in first-launch order
  counts: { workers: number; dispatches: number; reviews: number; merges: number; fixers: number; crossModelReviews: number; branchReviews: number };
  // crossModelReviews: review events with by === 'cross-model' (they review the MERGED result and carry no slug)
  // branchReviews: review events that carry a slug (per-branch reviews)
  verifyOk: boolean; // run.verify_ok
}

export function buildStory(run: FeaturedRun): Story {
  const byOrder = [...run.events].sort((a, b) => a.order - b.order);
  const dispatches = byOrder.filter((e) => e.type === 'dispatch');
  const merges = byOrder.filter((e) => e.type === 'merge');
  const reviews = byOrder.filter((e) => e.type === 'review');

  // First dispatch order per slug (workers only; extra branches like cronfix
  // also dispatch but are never in run.workers, so they never become workers).
  const firstDispatch = new Map<string, number>();
  for (const e of dispatches) {
    if (e.slug === undefined) continue;
    if (!firstDispatch.has(e.slug)) firstDispatch.set(e.slug, e.order);
  }
  // Dispatch lane per slug (first dispatch wins; used for fixer lanes).
  const dispatchLane = new Map<string, Lane>();
  for (const e of dispatches) {
    if (e.slug === undefined || e.lane === undefined) continue;
    if (!dispatchLane.has(e.slug)) dispatchLane.set(e.slug, e.lane);
  }

  // Launch order: workers sorted by first dispatch order; no dispatch -> last.
  const launchSorted = run.workers
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const ao = firstDispatch.has(a.w.slug) ? (firstDispatch.get(a.w.slug) as number) : Infinity;
      const bo = firstDispatch.has(b.w.slug) ? (firstDispatch.get(b.w.slug) as number) : Infinity;
      return ao - bo || a.i - b.i;
    });
  const launchIndex = new Map<string, number>();
  launchSorted.forEach(({ w }, rank) => launchIndex.set(w.slug, rank));

  // First worker_done order per slug.
  const firstDone = new Map<string, number>();
  for (const e of byOrder) {
    if (e.type !== 'worker_done' || e.slug === undefined) continue;
    if (!firstDone.has(e.slug)) firstDone.set(e.slug, e.order);
  }
  // Build order: workers with a worker_done first (by first done order),
  // workers with none come last, in launch order.
  const withDone = launchSorted.filter(({ w }) => firstDone.has(w.slug));
  const withoutDone = launchSorted.filter(({ w }) => !firstDone.has(w.slug));
  withDone.sort(
    (a, b) => (firstDone.get(a.w.slug) as number) - (firstDone.get(b.w.slug) as number) || a.i - b.i,
  );
  const buildOrdered = [...withDone, ...withoutDone];
  const buildIndex = new Map<string, number>();
  buildOrdered.forEach(({ w }, rank) => buildIndex.set(w.slug, rank));

  // Merge position per slug (first merge with that slug wins).
  const mergePos = new Map<string, number>();
  merges.forEach((e, idx) => {
    if (e.slug === undefined) return;
    if (!mergePos.has(e.slug)) mergePos.set(e.slug, idx);
  });

  const workers: StoryWorker[] = launchSorted.map(({ w }) => {
    const failedVerifies = byOrder.filter(
      (e) => e.type === 'verify' && e.slug === w.slug && e.ok === false,
    ).length;
    const failed = failedVerifies > 0;

    let fixer: StoryWorker['fixer'] = null;
    if (w.merged_via !== undefined) {
      const lane = dispatchLane.get(w.merged_via);
      if (lane !== undefined) fixer = { slug: w.merged_via, lane };
    }

    const ownReviews = reviews.filter((e) => e.slug === w.slug);
    const reviewed = ownReviews.length > 0;
    const reviewedBy: StoryWorker['reviewedBy'] = !reviewed
      ? null
      : ownReviews.some((e) => e.by === 'cross-model')
        ? 'cross-model'
        : 'orchestrator';

    const target = fixer !== null ? fixer.slug : w.slug;
    const mergeIndex = mergePos.has(target) ? (mergePos.get(target) as number) : null;

    return {
      slug: w.slug,
      lane: w.lane,
      launchIndex: launchIndex.get(w.slug) as number,
      buildIndex: buildIndex.get(w.slug) as number,
      failedVerifies,
      resumes: w.resumes,
      failed,
      fixer,
      reviewed,
      reviewedBy,
      mergeIndex,
    };
  });

  const lanes: Lane[] = [];
  for (const sw of workers) {
    if (!lanes.includes(sw.lane)) lanes.push(sw.lane);
  }

  return {
    task: run.task,
    label: run.label,
    workers,
    lanes,
    counts: {
      workers: run.workers.length,
      dispatches: dispatches.length,
      reviews: reviews.length,
      merges: merges.length,
      // Extra branches (extra: true dispatches, e.g. cronfix) are not workers
      // but count as dispatches and as fixers.
      fixers: dispatches.filter((e) => e.extra === true).length,
      crossModelReviews: reviews.filter((e) => e.by === 'cross-model').length,
      branchReviews: reviews.filter((e) => e.slug !== undefined).length,
    },
    verifyOk: run.verify_ok,
  };
}
