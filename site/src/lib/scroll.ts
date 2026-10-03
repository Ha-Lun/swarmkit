// The one scroll source of truth (PLAN §5). One ScrollTrigger per chapter section writes
// { chapter, chapterProgress, globalProgress } into a plain object. The world only reads it.
// Lenis + GSAP follow the 5 fluid-motion rules: duration 1.0, lenis.on('scroll', ScrollTrigger.update),
// gsap.ticker.lagSmoothing(0), no DOM mutation in scroll callbacks, no triggers closer than 150px.
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { scrollToProgress, SEGMENTS } from './world/camera-path';
import { LOOP_VH, motion, walkCfg, walkRamp } from './world/motion-config';

export interface ScrollState {
  chapter: number;
  chapterProgress: number;
  globalProgress: number;
}

export interface Scroll {
  state: ScrollState;
  /** Stop and start page scroll. Each caller locks under its own reason; the page scrolls again only when every reason has let go. */
  lock(reason: string): void;
  unlock(reason: string): void;
  /** Scroll to a point in a chapter (smoothly) and let autoplay run on from there. */
  go(chapter: number, progress: number): void;
  /** The seconds the tour's route takes under autoplay (the world knows the route's length once it is built; before that a default). */
  setWalkSec(sec: number): void;
  dispose(): void;
}

export function initScroll(): Scroll {
  gsap.registerPlugin(ScrollTrigger);
  gsap.ticker.lagSmoothing(0);
  const lenis = new Lenis({ duration: 1.0, autoRaf: false, anchors: true, infinite: true, syncTouch: true }); // the page loops: the finale ends on the intro's opening frame (finale.ts)
  lenis.on('scroll', ScrollTrigger.update);
  const raf = (t: number) => lenis.raf(t * 1000);
  gsap.ticker.add(raf);

  const sections = [...document.querySelectorAll<HTMLElement>('main > section.chapter')];
  if (sections.length !== SEGMENTS.length) throw new Error(`scroll: ${sections.length} chapter sections, ${SEGMENTS.length} camera segments`);

  const locks = new Set<string>();
  const state: ScrollState = { chapter: 0, chapterProgress: 0, globalProgress: 0 };
  // Every trigger starts where the previous one ends (same viewport line), so globalProgress is continuous (scrollToProgress hits
  // SEGMENTS[i].t0/t1 exactly at the boundaries).
  const triggers = sections.map((el, i) => {
    const write = (p: number) => {
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

  // The page plays by itself once started: from the landing screen to the end of the loop the page scrolls at a steady rate per chapter (through the same scroll state as a wheel, so
  // the camera, fades and pull-back are untouched). It starts on the first downward scroll, key press or click at the landing screen (or the "Scroll to start" cue, a nav jump, a task
  // pick) and ends where the loop wraps back to the landing screen, which waits for the next start. Holding the primary pointer or pressing Space pauses it; your own scrolling always
  // wins and, once you scroll up, autoplay stays off until you scroll down again. Velocity eases, so start, pause and resume glide.
  let playing = false, held = false, paused = false, off = false, vel = 0, acc = 0, routeSec = 140, lastChapter = 0;
  const play = () => { playing = true; off = false; };
  const inPanel = (t: EventTarget | null) => t instanceof Element && !!t.closest('dialog'); // the Reference panel scrolls itself; its wheel and keys are not the page's
  const offVirtual = lenis.on('virtual-scroll', ({ deltaY, event }) => {
    if (!deltaY || inPanel(event.target)) return;
    if (deltaY > 0 && state.chapter === 0 && !playing) play(); // the first scroll down at the landing screen starts the story
    else off = deltaY < 0;
  });
  const onDown = (e: PointerEvent) => { if (e.button === 0 && !inPanel(e.target)) held = true; };
  const onUp = () => { held = false; };
  const inControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('a, button, input, select, textarea');
  const onKey = (e: KeyboardEvent) => {
    if (inPanel(e.target)) return;
    const down = e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'End';
    if (!playing && state.chapter === 0 && (down || (e.key === ' ' && !inControl(e.target)))) { if (e.key === ' ') e.preventDefault(); play(); }
    else if (e.key === ' ' && !e.repeat && playing && !inControl(e.target)) { e.preventDefault(); paused = !paused; }
    else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') off = true;
    else if (down) off = false;
  };
  // an in-page link into the story (the cue, a nav dot) starts it too; the wordmark (back to the top) and the Reference do not
  const onClick = (e: MouseEvent) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    const h = a?.getAttribute('href');
    if (a && h && h !== '#top' && !h.startsWith('#ref') && !inPanel(a)) play();
  };
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  window.addEventListener('blur', onUp);
  window.addEventListener('keydown', onKey);
  document.addEventListener('click', onClick);
  const ap = motion.autoplay;
  const loopFrom = 1 - LOOP_VH / (motion.runway.finale - 40);
  /** progress per second of the chapter under autoplay at chapter progress p */
  const perSecAt = (ch: number, p: number): number => {
    if (ch === 0) return 1 / ap.introSec;
    if (ch === 1) return 1 / ap.hiveSec;
    if (ch === 3) return 1 / ap.proofSec;
    if (ch === 4) return p < loopFrom ? loopFrom / ap.finaleSec : (1 - loopFrom) / ap.loopSec;
    // Cells: the dive, the route and the rise each have their own pace; the route runs at walkCfg.rate (so its holds and turns are in seconds)
    const w = motion.walkAuto;
    return p < walkCfg.uFrom ? (walkCfg.uFrom - walkRamp.inFrom) / w.diveSec : p < walkCfg.uTo ? (walkCfg.uTo - walkCfg.uFrom) / routeSec : (1 - walkCfg.uTo) / w.tailSec;
  };
  const auto = (_t: number, dtMs: number) => {
    const dt = Math.min(dtMs, 100) / 1000;
    if (lastChapter === sections.length - 1 && state.chapter === 0) { // the loop wrapped: back to the exact opening frame, and the landing screen waits for the next start
      playing = false; vel = 0; acc = 0;
      lenis.scrollTo(0, { immediate: true, force: true });
    }
    lastChapter = state.chapter;
    // (not `!lenis.isScrolling`: our own scrollTo raises 'native' for a few frames after every step, which held autoplay off four frames in five; only the wheel's and touch's own inertia, 'smooth', is the user scrolling)
    const go = playing && !held && !paused && !off && lenis.isScrolling !== 'smooth' && !lenis.isStopped;
    const ch = state.chapter, tr = triggers[ch];
    const pxPerSec = (tr.end - tr.start) * perSecAt(ch, state.chapterProgress);
    vel += ((go ? pxPerSec : 0) - vel) * (1 - Math.exp(-dt / ap.easeSec));
    if (Math.abs(lenis.scroll - acc) > 2) acc = lenis.scroll; // moved by something else (scrollbar, wheel, anchor): follow it
    if (vel < 0.5) return;
    acc += vel * dt; // own float accumulator: a sub-pixel step per frame would otherwise round away
    lenis.scrollTo(acc, { immediate: true });
  };
  gsap.ticker.add(auto);

  return {
    state,
    setWalkSec(sec) { routeSec = sec; },
    go(chapter, progress) {
      const t = triggers[chapter];
      play(); paused = false;
      lenis.scrollTo(t.start + progress * (t.end - t.start), { duration: 1.6 });
    },
    lock(reason) { locks.add(reason); lenis.stop(); },
    unlock(reason) { locks.delete(reason); if (!locks.size) lenis.start(); },
    dispose() {
      triggers.forEach((t) => t.kill());
      gsap.ticker.remove(raf);
      gsap.ticker.remove(auto);
      offVirtual();
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      lenis.destroy();
    },
  };
}
