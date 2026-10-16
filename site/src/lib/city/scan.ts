// City scan part: a sweeping verify/review indicator plus per-lot pass/flag markers.
//
// Indicator over state.activeScan.target (a lot slug; over layout.cityBlock when
// the target is null), driven by activeScan.progress:
// - verify: a thin ring that sweeps up the lot;
// - orchestrator-review: a larger thin ring;
// - cross-model-review: a wide flat bar sweeping across the whole block;
// - kind null: the indicator is invisible.
// Per original lot a marker floats above the lot (position via lotPoseAt):
// - scan passed: a tick-like shape (two line segments, palette.ok);
// - scan flagged: a flag-like shape (a pole plus a triangle, palette.fail);
// - scanning / none: nothing extra. Status is always a shape, never colour alone.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  TorusGeometry,
} from 'three';
import { lotPoseAt } from './lots.ts';
import type { CityPalette, CityPart, CreateScan, LotLayout, StageState } from './types.ts';

/** Marker float height above the lot top (m). */
const MARKER_LIFT = 0.55;
/** Sweep ring base height above the lot base (m). */
const RING_BASE = 0.06;
/** Cross-model bar float height above the tallest lot (m). */
const BAR_LIFT = 0.6;
/** Idle bob amplitude (m); phase comes from state.runTime so a state always draws the same. */
const BOB_AMP = 0.06;

export const createScan: CreateScan = (layout: LotLayout, palette: CityPalette): CityPart => {
  const root = new Group();
  root.name = 'scan';

  // Original-lot indices in layout order (state.workers[k] <-> layout.lots[origIdx[k]]),
  // plus lot -> worker/extra index maps for scan targets.
  const origIdx: number[] = [];
  const lotToWorker: number[] = [];
  const lotToExtra: number[] = [];
  const slugToLot = new Map<string, number>();
  let foot = 0;
  let maxH = 0;
  for (let i = 0; i < layout.lots.length; i++) {
    const lot = layout.lots[i];
    if (lot === undefined) continue;
    slugToLot.set(lot.slug, i);
    lotToWorker.push(-1);
    lotToExtra.push(-1);
    if (lot.height > maxH) maxH = lot.height;
    if (lot.extra) continue;
    if (foot <= 0) foot = lot.w < lot.d ? lot.w : lot.d;
    lotToWorker[i] = origIdx.length;
    origIdx.push(i);
  }
  let extraSeen = 0;
  for (let i = 0; i < layout.lots.length; i++) {
    const lot = layout.lots[i];
    if (lot === undefined || !lot.extra) continue;
    lotToExtra[i] = extraSeen;
    extraSeen++;
  }
  if (foot <= 0) foot = 3.6;
  if (maxH <= 0) maxH = 1;

  // --- Shared geometries and materials (disposed once in dispose()).
  const verifyGeo = new TorusGeometry(foot * 0.32, 0.045, 6, 40);
  const orchGeo = new TorusGeometry(foot * 0.55, 0.05, 6, 48);
  const blockD = layout.cityBlock.d > 0.1 ? layout.cityBlock.d : 1;
  const barGeo = new BoxGeometry(0.35, 0.14, blockD);
  // Tick: two line segments sharing a corner (4 vertices).
  const tickGeo = new BufferGeometry();
  tickGeo.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-0.21, 0, 0, -0.08, 0.15, 0, -0.08, 0.15, 0, 0.21, 0.46, 0]),
      3,
    ),
  );
  const poleGeo = new BoxGeometry(0.05, 0.7, 0.05);
  // Flag cloth: one triangle (3 vertices), a different count from the tick.
  const flagGeo = new BufferGeometry();
  flagGeo.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0.03, 0.66, 0, 0.03, 0.38, 0, 0.42, 0.52, 0]), 3),
  );
  flagGeo.computeVertexNormals();

  const verifyMat = new MeshLambertMaterial({ color: palette.line });
  const orchMat = new MeshLambertMaterial({ color: palette.lightWarm });
  const barMat = new MeshLambertMaterial({ color: palette.ink });
  const okMat = new LineBasicMaterial({ color: palette.ok });
  const failMat = new MeshLambertMaterial({ color: palette.fail, side: DoubleSide });

  // --- Sweeping indicator meshes (exactly one kind visible at a time, none when idle).
  const verifyRing = new Mesh(verifyGeo, verifyMat);
  verifyRing.name = 'scan-ind-verify';
  verifyRing.rotation.x = -Math.PI / 2;
  verifyRing.visible = false;
  const orchRing = new Mesh(orchGeo, orchMat);
  orchRing.name = 'scan-ind-orch';
  orchRing.rotation.x = -Math.PI / 2;
  orchRing.visible = false;
  const crossBar = new Mesh(barGeo, barMat);
  crossBar.name = 'scan-ind-cross';
  crossBar.visible = false;
  root.add(verifyRing);
  root.add(orchRing);
  root.add(crossBar);

  // --- Per-original-lot markers.
  const n = origIdx.length;
  const markers: Group[] = [];
  const ticks: LineSegments[] = [];
  const flags: Group[] = [];
  for (let k = 0; k < n; k++) {
    const li = origIdx[k];
    if (li === undefined) continue;
    const lot = layout.lots[li];
    if (lot === undefined) continue;
    const g = new Group();
    g.name = 'scan-marker-' + lot.slug;
    const tick = new LineSegments(tickGeo, okMat);
    tick.name = 'scan-tick-' + lot.slug;
    tick.visible = false;
    const flag = new Group();
    flag.name = 'scan-flag-' + lot.slug;
    const pole = new Mesh(poleGeo, failMat);
    pole.position.y = 0.35;
    const cloth = new Mesh(flagGeo, failMat);
    cloth.name = 'scan-flag-cloth-' + lot.slug;
    flag.add(pole);
    flag.add(cloth);
    flag.visible = false;
    g.add(tick);
    g.add(flag);
    root.add(g);
    markers.push(g);
    ticks.push(tick);
    flags.push(flag);
  }

  // Scratch pose for lotPoseAt (reused every frame; never allocated in update).
  const pose = { x: 0, y: 0, z: 0 };
  let disposed = false;

  function update(state: StageState, dt: number): void {
    void dt;
    const bob = Math.sin(state.runTime * 1.7) * BOB_AMP;

    const scan = state.activeScan;
    const kind = scan.kind;
    let p = scan.progress;
    if (!(p >= 0)) p = 0;
    else if (p > 1) p = 1;

    const showVerify = kind === 'verify';
    const showOrch = kind === 'orchestrator-review';
    const showCross = kind === 'cross-model-review';
    verifyRing.visible = showVerify;
    orchRing.visible = showOrch;
    crossBar.visible = showCross;

    if (showVerify || showOrch) {
      const ring = showVerify ? verifyRing : orchRing;
      const target = scan.target;
      let li = -1;
      if (target !== null) {
        const got = slugToLot.get(target);
        li = got === undefined ? -1 : got;
      }
      if (li >= 0) {
        const lot = layout.lots[li];
        if (lot !== undefined) {
          let m = 0;
          const wk = lotToWorker[li];
          if (wk !== undefined && wk >= 0) {
            const w = state.workers[wk];
            if (w !== undefined) m = w.merge;
          } else {
            const xk = lotToExtra[li];
            if (xk !== undefined && xk >= 0) {
              const x = state.extras[xk];
              if (x !== undefined) m = x.merge;
            }
          }
          lotPoseAt(layout, li, m, pose);
          ring.position.set(pose.x, pose.y + RING_BASE + p * lot.height, pose.z);
        }
      } else {
        ring.position.set(layout.cityBlock.x, RING_BASE + p * maxH, layout.cityBlock.z);
      }
    }
    if (showCross) {
      const cb = layout.cityBlock;
      crossBar.position.set(cb.x - cb.w / 2 + cb.w * p, maxH + BAR_LIFT + bob, cb.z);
    }

    const wn = state.workers.length < n ? state.workers.length : n;
    for (let k = 0; k < wn; k++) {
      const w = state.workers[k];
      const li = origIdx[k];
      const g = markers[k];
      const tick = ticks[k];
      const flag = flags[k];
      if (w === undefined || li === undefined || g === undefined || tick === undefined || flag === undefined) continue;
      const lot = layout.lots[li];
      if (lot === undefined) continue;
      lotPoseAt(layout, li, w.merge, pose);
      g.position.set(pose.x, pose.y + lot.height + MARKER_LIFT + bob, pose.z);
      const sc = w.scan;
      tick.visible = sc === 'passed';
      flag.visible = sc === 'flagged';
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    verifyGeo.dispose();
    orchGeo.dispose();
    barGeo.dispose();
    tickGeo.dispose();
    poleGeo.dispose();
    flagGeo.dispose();
    verifyMat.dispose();
    orchMat.dispose();
    barMat.dispose();
    okMat.dispose();
    failMat.dispose();
  }

  return { object: root, update, dispose };
};
