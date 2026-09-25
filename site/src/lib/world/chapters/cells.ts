// Chapter 2. The camera flies along the lattice (camera-path.ts). Roster hover/focus lifts and glows that agent's
// cell; example route cards replay their route with the packet. Both read the data attributes already on the DOM
// (data-agent, data-example, data-route-agent). Listeners are DOM events, not scroll: the scroll state is untouched.
import { Vector3 } from 'three';
import { motion } from '../motion-config';
import { entryPoint, headAt, makeTimeline, stopProgress, withArcs, type Timeline } from '../routes';
import type { Chapter, WorldCtx } from '../types';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (t: number) => t * t * (3 - 2 * t);
const agentOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>('[data-agent]')?.dataset.agent ?? null : null);
const cardOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>('[data-example]') : null);

export function createCells(ctx: WorldCtx): Chapter {
  const { view } = ctx;
  const tmp = new Vector3();
  const core = ctx.lattice.cells.find((c) => c.agent?.band === 'core')?.agent?.name;
  let hovered: string | null = null;
  let focused: string | null = null;
  let lastCard: HTMLElement | null = null; // replay once per hover, not on every child the pointer crosses
  let playing: { t0: number; tl: Timeline; stops: string[]; card: HTMLElement } | null = null;

  function play(card: HTMLElement) {
    if (playing?.card === card) return;
    const names = [...card.querySelectorAll<HTMLElement>('[data-route-agent]')].map((e) => e.dataset.routeAgent!);
    const stops = [core, ...names].filter((n): n is string => !!n && ctx.cellIndex(n) >= 0);
    const pts = stops.map((n) => ctx.cellTop(n, new Vector3())!);
    if (!pts.length) return;
    const flow = ctx.flows[0];
    const len = flow.setRoute(withArcs([entryPoint(ctx.lattice), ...pts]));
    const s = stopProgress(flow.curve, pts);
    // a route with no agent step (a direct edit) still visits the core and stops there
    playing = { t0: ctx.time, tl: makeTimeline(len, s, motion.packet.unitsPerSec, s.map(() => motion.packet.dwellSec)), stops, card };
  }

  const onOver = (e: PointerEvent) => {
    hovered = agentOf(e.target);
    const card = cardOf(e.target);
    if (card && card !== lastCard) { lastCard = card; play(card); }
  };
  const onOut = (e: PointerEvent) => {
    if (agentOf(e.target) && agentOf(e.relatedTarget) !== agentOf(e.target)) hovered = agentOf(e.relatedTarget);
    if (cardOf(e.target) && cardOf(e.relatedTarget) !== cardOf(e.target)) lastCard = null;
  };
  const onFocusIn = (e: FocusEvent) => { focused = agentOf(e.target); };
  const onFocusOut = (e: FocusEvent) => { if (agentOf(e.target) && agentOf(e.relatedTarget) !== agentOf(e.target)) focused = agentOf(e.relatedTarget); };
  const onClick = (e: MouseEvent) => {
    const card = cardOf(e.target);
    if (card) { playing = null; play(card); } // click restarts the replay
  };

  return {
    enter() {
      document.addEventListener('pointerover', onOver);
      document.addEventListener('pointerout', onOut);
      document.addEventListener('focusin', onFocusIn);
      document.addEventListener('focusout', onFocusOut);
      document.addEventListener('click', onClick);
      focused = agentOf(document.activeElement); // focus may have arrived before this chapter became active
    },
    update() {
      const name = hovered ?? focused;
      if (name && ctx.cellTop(name, tmp)) {
        ctx.glow(name, 1);
        view.focus.copy(tmp);
        view.focusWeight = motion.camera.hoverBias;
      }
      if (playing) {
        const t = ctx.time - playing.t0;
        const flow = ctx.flows[0];
        const r = playing.tl.rAt(t);
        const fadeIn = clamp01(t / motion.packet.fadeSec);
        const fadeOut = 1 - smooth(clamp01((t - playing.tl.total) / motion.packet.fadeSec));
        flow.set(r, ctx.camera, Math.min(fadeIn, fadeOut));
        playing.tl.arrivals.forEach((at, i) => {
          const env = clamp01((t - at) / 0.2) * (1 - clamp01((t - at - 0.2) / motion.packet.dwellSec));
          if (playing!.stops[i]) ctx.glow(playing!.stops[i], env);
        });
        if (!name) {
          view.focus.copy(headAt(flow, r, tmp));
          view.focusWeight = motion.camera.routeBias;
          view.focusDrop = motion.camera.routeDrop;
        }
        view.overview = motion.camera.routeOverview;
        if (fadeOut <= 0) { flow.hide(); playing = null; }
      }
    },
    exit() {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('click', onClick);
      hovered = focused = lastCard = null;
      playing = null;
      ctx.flows[0].hide();
    },
    dispose() {
      this.exit();
    },
  };
}
