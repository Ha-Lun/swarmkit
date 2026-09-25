// Chapter 0. A timed growth sequence at load with scroll locked (skippable), plus a DOM text scramble on the
// title, then the tagline. The scramble is DOM only: it swaps glyphs inside per-character boxes of fixed width
// (no layout shift), the real text stays available to assistive tech, and nothing here runs under reduced motion.
import { SEGMENTS } from '../camera-path';
import { motion } from '../motion-config';
import { prefersReducedMotion } from '../tiers';
import type { Chapter, WorldCtx } from '../types';

export interface IntroChapter extends Chapter {
  /** starts the sequence (or skips it straight away); resolves when it has finished or been skipped */
  start(): Promise<void>;
  skip(): void;
}

const GLYPHS = '!<>-_/[]{}=+*^?#%&';
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

interface Scrambler {
  frame(ms: number): void;
  restore(): void;
}

function scrambler(el: HTMLElement, startMs: number, spanMs: number): Scrambler {
  const text = (el.textContent ?? '').trim();
  const height = el.offsetHeight;
  el.style.minHeight = `${height}px`; // belt and braces: a re-wrapped line must not push the page

  const live = document.createElement('span');
  live.setAttribute('aria-hidden', 'true');
  const real = document.createElement('span');
  real.className = 'sr-only';
  real.textContent = text;

  const chars: { box: HTMLSpanElement; ch: string; at: number; shown: string }[] = [];
  const words = text.split(' ');
  const n = text.replace(/ /g, '').length;
  let idx = 0;
  words.forEach((w, wi) => {
    const word = document.createElement('span');
    word.style.whiteSpace = 'nowrap';
    for (const ch of w) {
      const box = document.createElement('span');
      box.textContent = ch;
      word.append(box);
      // resolve left to right with a little jitter so it does not read as a wipe
      chars.push({ box, ch, at: startMs + ((idx++ + Math.random() * 3) / (n + 3)) * spanMs, shown: ch });
    }
    live.append(word);
    if (wi < words.length - 1) live.append(' ');
  });
  el.replaceChildren(live, real);
  // measure once with the real glyphs, then freeze every box to that width
  const widths = chars.map((c) => c.box.getBoundingClientRect().width);
  chars.forEach((c, i) => {
    c.box.style.display = 'inline-block';
    c.box.style.width = `${widths[i]}px`;
    c.box.style.textAlign = 'center';
  });

  return {
    frame(ms) {
      const tick = Math.floor(ms / 45); // glyphs change ~22 times a second
      for (const c of chars) {
        const next = ms >= c.at ? c.ch : GLYPHS[(tick * 7 + c.ch.charCodeAt(0)) % GLYPHS.length];
        if (next !== c.shown) { c.box.textContent = next; c.shown = next; }
      }
    },
    restore() {
      el.textContent = text;
      el.style.minHeight = '';
    },
  };
}

export function createIntro(ctx: WorldCtx): IntroChapter {
  const { view } = ctx;
  let started = false, running = false, done = false, t0 = -1;
  let resolve: (() => void) | null = null;
  let scramblers: Scrambler[] = [];
  const skipEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

  function finish() {
    if (done) return;
    done = true;
    running = false;
    view.camFloor = SEGMENTS[0].t1;
    scramblers.forEach((s) => s.restore());
    scramblers = [];
    skipEvents.forEach((e) => window.removeEventListener(e, skip));
    ctx.scroll.unlock();
    document.documentElement.dataset.world = 'ready';
    resolve?.();
    resolve = null;
  }
  function skip() {
    if (running) finish();
  }

  return {
    start() {
      if (started) return Promise.resolve();
      started = true;
      if (prefersReducedMotion() || window.scrollY > 4) { // restored scroll position or reduced motion: no intro
        finish();
        return Promise.resolve();
      }
      running = true;
      document.documentElement.dataset.world = 'intro';
      ctx.scroll.lock();
      const title = document.getElementById('intro-title');
      const tagline = document.querySelector<HTMLElement>('#top .motion-rise-late');
      if (title) scramblers.push(scrambler(title, motion.intro.titleStartMs, motion.intro.titleMs));
      if (tagline) scramblers.push(scrambler(tagline, motion.intro.taglineStartMs, motion.intro.taglineMs));
      skipEvents.forEach((e) => window.addEventListener(e, skip, { passive: true }));
      return new Promise<void>((r) => (resolve = r));
    },
    skip,
    enter() {},
    update() {
      if (!running) {
        view.growth = done ? 1 : 0;
        return;
      }
      if (t0 < 0) t0 = ctx.time;
      const ms = (ctx.time - t0) * 1000;
      const t = clamp01(ms / motion.intro.durationMs);
      view.growth = easeInOut(t);
      view.camFloor = easeInOut(t) * SEGMENTS[0].t1;
      scramblers.forEach((s) => s.frame(ms));
      if (t >= 1) finish();
    },
    exit() {},
    dispose() {
      skipEvents.forEach((e) => window.removeEventListener(e, skip));
      scramblers.forEach((s) => s.restore());
      ctx.scroll.unlock();
    },
  };
}
