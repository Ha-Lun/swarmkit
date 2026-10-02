// Chapter 0. A timed growth sequence at load with scroll locked (skippable), plus a DOM text scramble on the large
// wordmark, then the tagline. The scramble is DOM only: it swaps glyphs inside per-character boxes of fixed width
// (no layout shift), the real text stays available to assistive tech, and nothing here runs under reduced motion.
// As the page scrolls the wordmark shrinks and travels into the corner mark (transform and opacity only), while the
// corner mark fades in to take over. Everything is derived from chapterProgress, so scrolling back restores it.
import { SEGMENTS } from '../camera-path';
import { motion } from '../motion-config';
import { range, sceneOf, setOpacity } from '../scene-dom';
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
  const scene = sceneOf('top');
  const mark = document.getElementById('intro-title'); // the large wordmark
  const cornerPill = document.querySelector<HTMLElement>('.nav-mark'); // the corner mark it settles into
  const cornerText = document.getElementById('nav-mark-text');
  const tagWrap = scene.q('.intro-tagwrap')[0];
  const foot = scene.q('.scene-foot')[0];
  // untransformed geometry of the large mark (viewport coordinates: the scene is fixed) and the corner target (viewport), measured on demand
  let geo: { left: number; top: number; w: number; h: number; scale: number; tx: number; ty: number } | null = null;

  function measure() {
    if (!mark || !cornerText) return;
    const keep = mark.style.transform;
    mark.style.transform = 'none';
    const r = mark.getBoundingClientRect();
    mark.style.transform = keep;
    const c = cornerText.getBoundingClientRect();
    const scale = parseFloat(getComputedStyle(cornerText).fontSize) / parseFloat(getComputedStyle(mark).fontSize);
    geo = { left: r.left, top: r.top, w: r.width, h: r.height, scale, tx: c.left, ty: c.top + c.height / 2 - (r.height * scale) / 2 };
  }
  const onResize = () => measure();
  document.fonts?.ready.then(measure);
  /** t: 0 = large wordmark in place, 1 = settled into the corner mark */
  function applyMark(t: number) {
    setOpacity(cornerPill, range(t, 0.78, 1));
    if (!mark) return;
    if (!geo) measure();
    if (!geo) return;
    const dx = t * (geo.tx - geo.left);
    const dy = t * (geo.ty - geo.top);
    mark.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) scale(${(1 + t * (geo.scale - 1)).toFixed(4)})`;
    setOpacity(mark, 1 - range(t, 0.78, 1));
  }
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
    ctx.scroll.unlock('intro');
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
      window.addEventListener('resize', onResize);
      if (prefersReducedMotion() || window.scrollY > 4) { // restored scroll position or reduced motion: no intro
        applyMark(window.scrollY > 4 ? 1 : 0);
        finish();
        return Promise.resolve();
      }
      running = true;
      document.documentElement.dataset.world = 'intro';
      ctx.scroll.lock('intro');
      const title = mark; // the large wordmark scrambles in
      const tagline = document.querySelector<HTMLElement>('#top .motion-rise-late');
      if (title) scramblers.push(scrambler(title, motion.intro.titleStartMs, motion.intro.titleMs));
      if (tagline) scramblers.push(scrambler(tagline, motion.intro.taglineStartMs, motion.intro.taglineMs));
      skipEvents.forEach((e) => window.addEventListener(e, skip, { passive: true }));
      return new Promise<void>((r) => (resolve = r));
    },
    skip,
    enter() {},
    fade: (v) => scene.fade(v),
    update(p) {
      const lead = 1 - range(p, 0.1, 0.5);
      setOpacity(tagWrap, lead); // the tagline and the cue leave as the world starts to move
      setOpacity(foot, lead);
      applyMark(range(p, 0.02, 0.72));
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
    exit() {
      applyMark(1);
      scene.fade(0);
    },
    dispose() {
      window.removeEventListener('resize', onResize);
      if (mark) mark.style.transform = '';
      skipEvents.forEach((e) => window.removeEventListener(e, skip));
      scramblers.forEach((s) => s.restore());
      ctx.scroll.unlock('intro');
    },
  };
}
