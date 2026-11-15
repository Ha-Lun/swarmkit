// Downloadable artifacts: pure helpers for the info panel, the chat strip and the tool rows.
import type { ActivityEvent, PublishedArtifact, WrittenArtifact } from '../shared/types';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

/** Changes whenever the root node gets a new `result` event; the artifacts refetch keys off it. */
export function resultKey(events: ActivityEvent[] | undefined): string {
  let count = 0;
  let last = '';
  for (const e of events ?? []) {
    if (e.kind === 'result') {
      count += 1;
      last = e.id;
    }
  }
  return `${count}:${last}`;
}

/**
 * Published files per finished turn, keyed by the id of the turn's last assistant text event.
 * A turn runs from a user event to the next one; it is finished once a later turn started
 * or its own `result` event arrived. A file belongs to the turn whose window holds its mtime,
 * so the strips survive a reload.
 */
export function turnArtifacts(
  events: ActivityEvent[],
  published: PublishedArtifact[],
): Map<string, PublishedArtifact[]> {
  const out = new Map<string, PublishedArtifact[]>();
  if (published.length === 0) return out;
  const starts: number[] = [];
  for (let i = 0; i < events.length; i++) if (events[i].kind === 'user') starts.push(i);
  starts.forEach((from, n) => {
    const next = n + 1 < starts.length ? starts[n + 1] : undefined;
    const turn = events.slice(from, next ?? events.length);
    const finished = next !== undefined || turn.some((e) => e.kind === 'result');
    if (!finished) return;
    const anchor = [...turn].reverse().find((e) => e.kind === 'text');
    if (!anchor) return;
    const start = events[from].ts;
    const end = next !== undefined ? events[next].ts : Infinity;
    const files = published.filter((f) => f.mtime >= start && f.mtime < end);
    if (files.length > 0) out.set(anchor.id, files);
  });
  return out;
}

/** The written artifact a Write/Edit/NotebookEdit row points at, matched by absolute path or trailing `rel`. */
export function matchWritten(
  tool: string | undefined,
  summary: string,
  written: WrittenArtifact[],
): WrittenArtifact | undefined {
  if (!tool || !WRITE_TOOLS.has(tool)) return undefined;
  const path = summary.trim();
  if (!path) return undefined;
  return written.find((w) => w.path === path || path === w.rel || path.endsWith(`/${w.rel}`));
}
