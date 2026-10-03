// DOM side of the pinned scenes. Chapters call these from update(); the only thing ever written is
// opacity (plus `inert` on a scene that is fully faded), never layout, and never a node insert or remove.
// Everything a chapter drives carries data-fx, so resetFx() can hand the page back to the static layout.

import { motion, LOOP_VH } from './motion-config';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
export const range = (p: number, a: number, b: number) => smooth(clamp01((p - a) / (b - a)));

const last = new WeakMap<HTMLElement, number>();

/** Write an opacity only when it visibly changed. */
export function setOpacity(el: HTMLElement | null | undefined, v: number) {
  if (!el) return;
  const q = Math.round(clamp01(v) * 500) / 500;
  if (last.get(el) === q) return;
  last.set(el, q);
  el.style.opacity = String(q);
}

/** Scroll, in viewport-height percent, over which a fixed scene fades: the last FADE_VH of its runway out, the first FADE_VH of the next in. */
export const FADE_VH = 25;
const RUNWAYS = [motion.runway.intro, motion.runway.hive, motion.runway.cells, motion.runway.proof, motion.runway.finale];

/** Scroll length (percent of a viewport height) that chapterProgress spans: scroll.ts runs a chapter from "top 60%" to "bottom 60%"
 *  (the first from "top top", the last to "bottom bottom"). */
function spanVh(chapter: number): number {
  const r = RUNWAYS[chapter];
  return chapter === 0 ? r - 60 : chapter === RUNWAYS.length - 1 ? r - 40 : r;
}

/** [start, end] of chapterProgress during which a chapter's scene is fully visible (between its fade in and its fade out). */
export function pinWindow(vh: number, lastChapter = false): [number, number] {
  const span = lastChapter ? vh - 40 : vh;
  return [FADE_VH / span, 1 - FADE_VH / span];
}

/**
 * Opacity of chapter `chapter`'s fixed scene, 0..1, from its chapterProgress: in over the first FADE_VH of its runway, out over the
 * last FADE_VH. Consecutive chapters share the boundary (one's p = 1 is the next one's p = 0), so the outgoing scene is gone before
 * the incoming one begins: never two text layers at once, and nothing moves, only opacity changes. The intro has no fade of its own
 * (its parts leave on their own clocks, intro.ts).
 */
export function sceneAlpha(chapter: number, p: number): number {
  if (chapter === 0) return 1;
  const s = p * spanVh(chapter), span = spanVh(chapter);
  const outFrom = chapter === RUNWAYS.length - 1 ? span - LOOP_VH : span - FADE_VH; // the finale leaves as the homecoming starts, so the intro's text comes in on a clear screen
  return range(s, 0, FADE_VH) * (1 - range(s, outFrom, outFrom + FADE_VH));
}

export interface Scene {
  root: HTMLElement | null;
  /** fade the whole scene; a scene that is fully faded is inert so hidden controls leave the tab order */
  fade(v: number): void;
  q<T extends HTMLElement = HTMLElement>(sel: string): T[];
}

export function sceneOf(sectionId: string): Scene {
  const root = document.querySelector<HTMLElement>(`#${sectionId} [data-scene]`);
  return {
    root,
    fade(v) {
      if (!root) return;
      setOpacity(root, v);
      const off = v < 0.05;
      if (root.inert !== off) root.inert = off;
    },
    q: <T extends HTMLElement>(sel: string) => (root ? [...root.querySelectorAll<T>(sel)] : []),
  };
}

/** Back to the static page (tier fallback): drop every inline opacity and inert flag a chapter wrote. */
export function resetFx() {
  document.querySelectorAll<HTMLElement>('[data-scene], [data-fx]').forEach((el) => {
    el.style.opacity = '';
    el.inert = false;
    last.delete(el);
  });
}
