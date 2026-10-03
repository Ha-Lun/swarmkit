// Chapter 1. The task waits: the comet hovers (breathing) at its entry point above the globe, drawn by the journey comet (journey-comet.ts), and the three task buttons are the pick. Pressing one
// chooses that task's journey (view.journey) and starts it: the Cells chapter flies the same comet in, and the camera follows it. Without a pick the default journey plays when you scroll on.
// The caption is pre-rendered; this chapter only writes its opacity, so nothing is inserted or removed mid-scroll.
import { walkRamp } from '../motion-config';
import { range, sceneOf, setOpacity } from '../scene-dom';
import type { Chapter, WorldCtx } from '../types';

export function createHive(ctx: WorldCtx): Chapter {
  const { view, routing } = ctx;
  const scene = sceneOf('hive');
  const caption = scene.q('[data-caption]')[0]; // "A task comes in."
  const chipRings = new Map(scene.q('[data-chip]').map((e) => [e.dataset.chip!, e.querySelector<HTMLElement>('.chip-ring')!]));

  const onClick = (e: MouseEvent) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-pick]') : null;
    if (!btn) return;
    view.journey = Number(btn.dataset.pick);
    ctx.scroll.go(2, walkRamp.inFrom + 0.004); // start the journey: the dive, then the flight (autoplay takes over from there)
  };

  return {
    enter() {
      document.addEventListener('click', onClick);
    },
    fade: (v) => scene.fade(v),
    update(p) {
      ctx.comet.update(ctx.walkRoute, -1, 0, 0); // waiting at the entry point
      setOpacity(caption, 1 - range(p, 0.7, 1));
      const tier = routing.journeys[view.journey]?.tier;
      chipRings.forEach((ring, id) => setOpacity(ring, id === tier ? 1 : 0)); // the chosen task's tier is lit
    },
    exit() {
      ctx.comet.clear();
      chipRings.forEach((ring) => setOpacity(ring, 0));
      document.removeEventListener('click', onClick);
      scene.fade(0);
    },
    dispose() {
      document.removeEventListener('click', onClick);
    },
  };
}
