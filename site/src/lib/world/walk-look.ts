// Drag-to-look for the walker. Scroll still moves the walker along the street; dragging the pointer turns the head (yaw about the walker's up, pitch
// about the camera's right) on top of the walker's own orientation. The offset is smoothed, stays where you leave it, and is faded out by the caller
// with the walk weight (so the dive and the rise are never turned). Mouse and pen only: on touch a drag scrolls the page.
import { MathUtils } from 'three';

const SENS = 0.3 * (Math.PI / 180); // radians per pixel: a full turn is about 1200 px of drag
export const LOOK_PITCH_MIN = -1.05; // 60 degrees down
export const LOOK_PITCH_MAX = 1.4; // 80 degrees up on top of the walker's own tilt

export interface WalkLook {
  /** smoothed offsets, radians (positive yaw turns left, positive pitch looks up) */
  yaw: number;
  pitch: number;
  dragging: boolean;
  enable(): void;
  disable(): void;
  /** advance the smoothing; `active` = the camera is on the ground (drags are ignored otherwise and the offset is dropped when it is far from the walk) */
  step(dt: number, active: boolean, walk: number): void;
  reset(): void;
}

/** `ignore` = selector of things a drag must not start on (links, buttons, the agent list, the bench sidebar) */
export function createWalkLook(ignore = 'a, button, input, select, textarea, [data-agent-list], .cell-card, #side, #bar'): WalkLook {
  let tyaw = 0, tpitch = 0, px = 0, py = 0, pid = -1, on = false, live = false;
  const look: WalkLook = {
    yaw: 0, pitch: 0, dragging: false,
    enable() {
      if (on) return;
      on = true;
      window.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('dblclick', dbl);
    },
    disable() {
      if (!on) return;
      on = false;
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('dblclick', dbl);
      up();
      look.reset();
    },
    step(dt, active, walk) {
      live = active;
      if (!active && !look.dragging) { if (walk < 0.05) look.reset(); }
      const k = 1 - Math.exp(-14 * dt);
      look.yaw += (tyaw - look.yaw) * k;
      look.pitch += (tpitch - look.pitch) * k;
    },
    reset() { tyaw = tpitch = look.yaw = look.pitch = 0; },
  };
  function down(e: PointerEvent) {
    if (!live || e.pointerType === 'touch' || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest(ignore)) return;
    pid = e.pointerId; px = e.clientX; py = e.clientY; look.dragging = true;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }
  function move(e: PointerEvent) {
    if (!look.dragging || e.pointerId !== pid) return;
    tyaw += (e.clientX - px) * SENS; // (grab metaphor: dragging right pulls the scene right, so the head turns left)
    tpitch = MathUtils.clamp(tpitch + (e.clientY - py) * SENS, LOOK_PITCH_MIN, LOOK_PITCH_MAX);
    px = e.clientX; py = e.clientY;
  }
  function up() {
    if (!look.dragging) return;
    look.dragging = false; pid = -1;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
  function dbl(e: MouseEvent) {
    if (live && !(e.target instanceof Element && e.target.closest(ignore))) { tyaw = tpitch = 0; } // double click: look forward again
  }
  return look;
}
