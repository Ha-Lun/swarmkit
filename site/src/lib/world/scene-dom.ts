// DOM side of the pinned scenes. Chapters call these from update(); the only thing ever written is
// opacity (plus `inert` on a scene that is fully faded), never layout, and never a node insert or remove.
// Everything a chapter drives carries data-fx, so resetFx() can hand the page back to the static layout.

import { motion } from './motion-config';

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

/** [start, end] of chapterProgress during which the sticky scene is pinned, for a runway of `vh` viewport heights.
 *  scroll.ts runs a chapter from "top 60%" to "bottom 60%" (the last one to "bottom bottom"). */
export function pinWindow(vh: number, lastChapter = false): [number, number] {
  const span = lastChapter ? vh - 0.4 : vh;
  return [0.6 / span, lastChapter ? 1 : (vh - 0.4) / span];
}

/**
 * Where, in scroll past a chapter boundary (percent of a viewport height, the unit of motion.runway), one pinned scene hands over
 * to the next. Scene text sits at the bottom of its 100vh box, so the incoming scene's text only comes on screen as the box
 * finishes sliding in (0.6 of a viewport past the boundary) and the outgoing scene's text leaves through the top by the same
 * point. The window straddles that moment, so the outgoing text is already fading as it slides away and the incoming text is
 * already partway up as it appears: one ease, two complementary opacities, no gap and no stack of both at full strength.
 */
export const HANDOVER: [number, number] = [30, 90];
const RUNWAYS = [motion.runway.intro, motion.runway.hive, motion.runway.cells, motion.runway.proof, motion.runway.finale];

/**
 * How far chapter `chapter`'s scene has arrived, 0..1, from its chapterProgress. The world writes it to this scene and its
 * complement (1 - arrival) to the previous one, with the same ease, so the two always sum to 1.
 */
export function arrival(chapter: number, p: number): number {
  return chapter === 0 ? 1 : range(p * RUNWAYS[chapter], HANDOVER[0], HANDOVER[1]);
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
