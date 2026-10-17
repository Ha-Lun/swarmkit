// SwarmKit City scroll: the one scroll source of truth for the stage. Native scroll, no Lenis, no autoplay, no
// scroll lock. The stage section is tall (its runway is SCROLL_VH vh past one viewport) and holds a CSS-sticky,
// viewport-tall pin; one ScrollTrigger scrubs a tween that writes progress u (0..1) into a plain object. The scene
// only reads `progress.u`. Rules carried over from the old engine: no DOM mutation inside scroll callbacks (the
// tween only writes a number), and a single trigger (so no two triggers sit closer than 150px).
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

export interface ScrollProgress {
  /** Scroll progress through the stage runway, 0..1. Written by ScrollTrigger, read by the scene. */
  progress: { u: number };
  /** Calls `cb` when scrolling stops (static frames re-render then). Returns an unsubscribe function. */
  onScrollEnd(cb: () => void): () => void;
  destroy(): void;
}

export function createScrollProgress(stageEl: HTMLElement): ScrollProgress {
  gsap.registerPlugin(ScrollTrigger);
  const progress = { u: 0 };
  // Reduced motion does not change this: u is still written, the scene decides to show beat poses.
  const tween = gsap.to(progress, {
    u: 1,
    ease: 'none',
    scrollTrigger: { trigger: stageEl, start: 'top top', end: 'bottom bottom', scrub: true, invalidateOnRefresh: true },
  });
  const ends = new Set<() => void>();
  const onEnd = () => ends.forEach((cb) => cb());
  ScrollTrigger.addEventListener('scrollEnd', onEnd);
  // Fonts change line heights above the stage on first load; re-measure once they are in.
  document.fonts?.ready.then(() => ScrollTrigger.refresh());

  return {
    progress,
    onScrollEnd(cb) {
      ends.add(cb);
      return () => ends.delete(cb);
    },
    destroy() {
      ScrollTrigger.removeEventListener('scrollEnd', onEnd);
      ends.clear();
      tween.scrollTrigger?.kill();
      tween.kill();
    },
  };
}
