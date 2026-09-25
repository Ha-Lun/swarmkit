// Cell picking for the roster scene. A pointer raycast against the honeycomb's two InstancedMeshes (hex, pentagon; instanceId -> cell -> agent via
// the lattice) and a visually hidden but focusable agent list both resolve to one agent name; the caller lifts and
// lifts and brightens that cell, and this module places a pre-rendered label card at the cell's projected centre.
//
// The pointer listens on window and is attached only while the roster scene is active (the canvas itself sits
// under the DOM layers). The raycast runs at most once per frame, and every frame while the pointer is over the
// scene, because the camera keeps flying under a still pointer.
// Cards and list buttons are pre-rendered (data-card / data-agent); this only toggles classes and writes transform.
import { Raycaster, Vector2, Vector3 } from 'three';
import type { WorldCtx } from './types';

const CARD_GAP = 14; // px between the cell centre and the card
const EDGE = 12;
const NAV_H = 56; // clear of the fixed nav

export interface Pick {
  enable(): void;
  disable(): void;
  /** agent under the pointer, else the keyboard-focused one */
  update(): { name: string | null; byKeyboard: boolean };
  dispose(): void;
}

export function createPick(ctx: WorldCtx, root: HTMLElement | null): Pick {
  const ray = new Raycaster();
  const ndc = new Vector2();
  const tmp = new Vector3();
  let dirty = false, onCanvas = false;
  let hovered: string | null = null, focused: string | null = null;
  let shown: HTMLElement | null = null;
  let checkedComb: unknown = null;

  const cards = new Map<string, HTMLElement>();
  const buttons: HTMLElement[] = [];
  root?.querySelectorAll<HTMLElement>('[data-card]').forEach((c) => cards.set(c.dataset.card!, c));
  root?.querySelectorAll<HTMLElement>('[data-agent]').forEach((b) => buttons.push(b));
  const size = new WeakMap<HTMLElement, [number, number]>();

  const isControl = (t: EventTarget | null) => t instanceof Element && !!t.closest('a, button, input, select, [data-agent-list]');
  const onMove = (e: PointerEvent) => {
    if (isControl(e.target)) { onCanvas = false; dirty = true; return; }
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    onCanvas = true;
    dirty = true;
  };
  const onLeave = () => { onCanvas = false; dirty = true; };

  const nameOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>('[data-agent]')?.dataset.agent ?? null : null);
  const onFocusIn = (e: FocusEvent) => {
    focused = nameOf(e.target);
    buttons.forEach((b) => (b.tabIndex = b === e.target ? 0 : -1)); // roving tabindex: one tab stop for the whole list
  };
  const onFocusOut = (e: FocusEvent) => { if (nameOf(e.relatedTarget) === null) focused = null; };
  const onKey = (e: KeyboardEvent) => {
    const i = buttons.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    buttons[(next + buttons.length) % buttons.length].focus({ preventScroll: true });
  };

  function raycast(): string | null {
    const comb = ctx.comb;
    if (checkedComb !== comb) { comb.meshes.forEach((m) => m.computeBoundingSphere()); checkedComb = comb; } // matrices are settled by the time the roster is on screen
    ray.setFromCamera(ndc, ctx.camera);
    const hit = ray.intersectObjects(comb.meshes, false)[0]; // nearest across both meshes: the far side of the globe never wins
    return hit?.instanceId !== undefined ? ctx.lattice.cells[comb.cellAt(hit.object, hit.instanceId)]?.agent?.name ?? null : null;
  }

  function place(card: HTMLElement, name: string) {
    if (!ctx.cellTop(name, tmp)) return;
    tmp.project(ctx.camera);
    let dim = size.get(card);
    if (!dim) { dim = [card.offsetWidth, card.offsetHeight]; size.set(card, dim); }
    const w = window.innerWidth, h = window.innerHeight;
    const x = Math.min(w - EDGE - dim[0] / 2, Math.max(EDGE + dim[0] / 2, ((tmp.x + 1) / 2) * w));
    const y = Math.min(h - EDGE, Math.max(NAV_H + dim[1], ((1 - tmp.y) / 2) * h - CARD_GAP));
    card.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
  }

  return {
    enable() {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      root?.addEventListener('focusin', onFocusIn);
      root?.addEventListener('focusout', onFocusOut);
      root?.addEventListener('keydown', onKey);
      buttons.forEach((b, i) => (b.tabIndex = i === 0 ? 0 : -1));
    },
    disable() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      root?.removeEventListener('focusin', onFocusIn);
      root?.removeEventListener('focusout', onFocusOut);
      root?.removeEventListener('keydown', onKey);
      hovered = focused = null;
      onCanvas = dirty = false;
      shown?.classList.remove('is-on', 'is-key');
      shown = null;
      document.body.style.cursor = '';
    },
    update() {
      if (onCanvas || dirty) {
        dirty = false;
        hovered = onCanvas ? raycast() : null;
        document.body.style.cursor = hovered ? 'pointer' : '';
      }
      const name = hovered ?? focused;
      const byKeyboard = !hovered && !!focused;
      const card = name ? cards.get(name) ?? null : null;
      if (card !== shown) {
        shown?.classList.remove('is-on', 'is-key');
        card?.classList.add('is-on');
        shown = card;
      }
      if (card && name) {
        card.classList.toggle('is-key', byKeyboard);
        place(card, name);
      }
      return { name, byKeyboard };
    },
    dispose() {
      this.disable();
    },
  };
}
