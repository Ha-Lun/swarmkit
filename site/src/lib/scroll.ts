// The one scroll source of truth (PLAN §5). One ScrollTrigger per chapter section writes
// { chapter, chapterProgress, globalProgress } into a plain object. The world only reads it.
// Lenis + GSAP follow the 5 fluid-motion rules: duration 1.0, lenis.on('scroll', ScrollTrigger.update),
// gsap.ticker.lagSmoothing(0), no DOM mutation in scroll callbacks, no triggers closer than 150px.
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { scrollToProgress, SEGMENTS } from './world/camera-path';
import { motion } from './world/motion-config';

export interface ScrollState {
  chapter: number;
  chapterProgress: number;
  globalProgress: number;
}

export interface Scroll {
  state: ScrollState;
  lock(): void;
  unlock(): void;
  dispose(): void;
}

export function initScroll(): Scroll {
  gsap.registerPlugin(ScrollTrigger);
  gsap.ticker.lagSmoothing(0);
  const lenis = new Lenis({ duration: 1.0, autoRaf: false, anchors: true });
  lenis.on('scroll', ScrollTrigger.update);
  const raf = (t: number) => lenis.raf(t * 1000);
  gsap.ticker.add(raf);

  const sections = [...document.querySelectorAll<HTMLElement>('main > section.chapter')];
  if (sections.length !== SEGMENTS.length) throw new Error(`scroll: ${sections.length} chapter sections, ${SEGMENTS.length} camera segments`);

  const state: ScrollState = { chapter: 0, chapterProgress: 0, globalProgress: 0 };
  // Every trigger starts where the previous one ends (same viewport line), so globalProgress is continuous (scrollToProgress hits
  // SEGMENTS[i].t0/t1 exactly at the boundaries).
  const triggers = sections.map((el, i) => {
    const write = (p: number) => {
      // the walk is read at walking pace: wheel and touchpad input is scaled down in the Cells chapter (a touchpad flick sends thousands of px);
      // scrollbar drag and keyboard are not scaled. Lenis reads it from its virtual scroll on every wheel event.
      (lenis as unknown as { virtualScroll: { options: { wheelMultiplier: number } } }).virtualScroll.options.wheelMultiplier = i === 2 ? motion.walkScroll : 1;
      state.chapter = i;
      state.chapterProgress = p;
      state.globalProgress = scrollToProgress(i, p); // arc-length balanced: the camera speed per scroll never jumps at a chapter boundary
    };
    return ScrollTrigger.create({
      trigger: el,
      start: i === 0 ? 'top top' : 'top 60%',
      end: i === sections.length - 1 ? 'bottom bottom' : 'bottom 60%',
      // Only the active trigger writes (a leaving trigger's final callback would race the entering one),
      // except the last chapter, which has no successor and must be able to reach progress 1.
      onUpdate: (self) => (self.isActive || (i === sections.length - 1 && self.progress === 1)) && write(self.progress),
      onRefresh: (self) => (self.isActive || (i === sections.length - 1 && self.progress === 1)) && write(self.progress),
    });
  });
  document.fonts?.ready.then(() => ScrollTrigger.refresh());

  return {
    state,
    lock: () => lenis.stop(),
    unlock: () => lenis.start(),
    dispose() {
      triggers.forEach((t) => t.kill());
      gsap.ticker.remove(raf);
      lenis.destroy();
    },
  };
}
