// Chapter 1. The task waits: the comet hovers (breathing) at its entry point above the globe, drawn by the journey comet (journey-comet.ts), and its tag names it (the task was chosen on the landing screen,
// intro.ts). The Cells chapter flies the same comet in, and the camera follows it.
// The caption is pre-rendered; this chapter only writes its opacity, so nothing is inserted or removed mid-scroll.
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createHive(ctx: WorldCtx): Chapter {
  const { view, routing } = ctx;
  const scene = sceneOf('hive');
  const caption = scene.q('[data-caption]')[0]; // "A task comes in."
  const chipRings = new Map(scene.q('[data-chip]').map((e) => [e.dataset.chip!, e.querySelector<HTMLElement>('.chip-ring')!]));

  const tags = scene.q('[data-task-tag]').map((el) => ({ el, j: Number(el.dataset.j) })); // the task being told

  return {
    enter() {},
    fade: (v) => scene.fade(v),
    update(p) {
      ctx.comet.update(ctx.walkRoute, -1, 0, 0); // waiting at the entry point
      setOpacity(caption, 1 - range(p, 0.7, 1));
      const tier = routing.journeys[view.journey]?.tier;
      chipRings.forEach((ring, id) => setOpacity(ring, id === tier ? 1 : 0)); // the chosen task's tier is lit
      tags.forEach((t) => setOpacity(t.el, t.j === view.journey ? 1 : 0));
    },
    exit() {
      ctx.comet.clear();
      chipRings.forEach((ring) => setOpacity(ring, 0));
      tags.forEach((t) => setOpacity(t.el, 0));
      scene.fade(0);
    },
    dispose() {},
  };
}
