// City scan part: a sweeping verify/review indicator plus per-lot pass/flag markers.
//
// Indicator over state.activeScan.target (a lot slug; over the new-lot slot
// bounds when the target is null), driven by activeScan.progress:
// - verify: a thick flat ring that sweeps up the lot;
// - orchestrator-review: a larger thick ring;
// - cross-model-review: a wide flat bar sweeping across the new lots only
//   (the bounding rectangle of layout.block with a small margin, extended to
//   the annex slots of extras that have started building);
// - kind null: the indicator is invisible.
// Per original lot a marker floats above the building top (position via lotPoseAt):
// - scan passed: a check mark (a short and a long flat bar joined at a vertex, lying on its side so it reads as a V
//   from above, palette.ok);
// - scan flagged: a flag-like shape (a pole plus a triangular pennant, palette.fail);
// - scanning / none: nothing extra. Status is always a shape, never colour alone.
// Markers are meshes only (no lines: WebGL lines are 1px and vanish at distance),
// sized relative to the lot foot. The flag stands upright and is yawed ~45deg for the three-quarter camera; the
// check lies flat (a standing one goes edge-on to some camera yaws) and is yawed to open towards the typical camera.
import {
  BoxGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  Shape,
  ShapeGeometry,
  TorusGeometry,
} from 'three';
import { lotPoseAt } from './lots.ts';
import type { CityPalette, CityPart, CreateScan, LotLayout, StageState } from './types.ts';

/** Marker float margin above the building top (m). */
const MARKER_LIFT = 0.55;
/** Sweep ring base height above the lot base (m). */
const RING_BASE = 0.06;
/** Cross-model bar float height above the tallest lot (m). */
const BAR_LIFT = 0.6;
/** Idle bob amplitude (m); phase comes from state.runTime so a state always draws the same. */
const BOB_AMP = 0.06;
/** Marker yaw (rad) so flat shapes read from the three-quarter camera. */
const MARKER_YAW = Math.PI / 4;
/** Check yaw (rad): its "up" (the open side of the V) points away from a camera at ~52 deg yaw, between the landscape shots (8-36) and the portrait one (82), so it reads as a check from both. */
const TICK_YAW = (52 * Math.PI) / 180;
/** Cross-model sweep margin (m) around the new-lot slot bounds; under half a street. */
const SLOT_MARGIN = 0.6;

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

  // New-lot slot bounds, computed once: the bounding rectangle of the merged
  // slots (original lots only, so the old town in layout.existing is excluded)
  // plus the annex extension for extras. The annex part is precomputed and the
  // update switches between base and combined by state (extras build > 0).
  let slotX0 = Infinity, slotX1 = -Infinity, slotZ0 = Infinity, slotZ1 = -Infinity;
  for (let i = 0; i < layout.lots.length; i++) {
    const lot = layout.lots[i];
    if (lot === undefined || lot.extra) continue;
    const s = layout.block[i];
    if (s === undefined) continue;
    const x0 = s.x - s.w / 2, x1 = s.x + s.w / 2;
    const z0 = s.z - s.d / 2, z1 = s.z + s.d / 2;
    if (x0 < slotX0) slotX0 = x0;
    if (x1 > slotX1) slotX1 = x1;
    if (z0 < slotZ0) slotZ0 = z0;
    if (z1 > slotZ1) slotZ1 = z1;
  }
  let annexX0 = Infinity, annexX1 = -Infinity, annexZ0 = Infinity, annexZ1 = -Infinity;
  for (let j = 0; j < layout.annex.length; j++) {
    const s = layout.annex[j];
    if (s === undefined) continue;
    const x0 = s.x - s.w / 2, x1 = s.x + s.w / 2;
    const z0 = s.z - s.d / 2, z1 = s.z + s.d / 2;
    if (x0 < annexX0) annexX0 = x0;
    if (x1 > annexX1) annexX1 = x1;
    if (z0 < annexZ0) annexZ0 = z0;
    if (z1 > annexZ1) annexZ1 = z1;
  }
  const hasBase0 = slotX0 <= slotX1 && slotZ0 <= slotZ1;
  const hasAnnex0 = annexX0 <= annexX1 && annexZ0 <= annexZ1;
  if (!hasBase0) {
    if (hasAnnex0) {
      slotX0 = annexX0; slotX1 = annexX1; slotZ0 = annexZ0; slotZ1 = annexZ1;
    } else {
      slotX0 = layout.cityBlock.x - layout.cityBlock.w / 2;
      slotX1 = layout.cityBlock.x + layout.cityBlock.w / 2;
      slotZ0 = layout.cityBlock.z - layout.cityBlock.d / 2;
      slotZ1 = layout.cityBlock.z + layout.cityBlock.d / 2;
    }
  }
  let combX0 = slotX0, combX1 = slotX1, combZ0 = slotZ0, combZ1 = slotZ1;
  if (hasBase0 && hasAnnex0) {
    if (annexX0 < combX0) combX0 = annexX0;
    if (annexX1 > combX1) combX1 = annexX1;
    if (annexZ0 < combZ0) combZ0 = annexZ0;
    if (annexZ1 > combZ1) combZ1 = annexZ1;
  }
  const useAnnexSwitch = hasBase0 && hasAnnex0;
  const baseEx0 = slotX0 - SLOT_MARGIN;
  const baseEx1 = slotX1 + SLOT_MARGIN;
  const baseEz0 = slotZ0 - SLOT_MARGIN;
  const baseEz1 = slotZ1 + SLOT_MARGIN;
  const combEx0 = combX0 - SLOT_MARGIN;
  const combEx1 = combX1 + SLOT_MARGIN;
  const combEz0 = combZ0 - SLOT_MARGIN;
  const combEz1 = combZ1 + SLOT_MARGIN;

  // --- Shared geometries and materials (disposed once in dispose()).
  // Thick sweep rings: torus tubes with visible width, laid flat.
  const verifyGeo = new TorusGeometry(foot * 0.32, Math.max(0.09, foot * 0.028), 8, 40);
  const orchGeo = new TorusGeometry(foot * 0.55, Math.max(0.1, foot * 0.034), 8, 48);
  // Flat wide bar: wide in x, thin in y, unit depth in z scaled per-frame to
  // the effective new-lot bounds (base or base+annex).
  // A thin translucent sheet, not a solid slab: a dark 3D block read as a black rectangle over the labels.
  const barW = Math.max(0.4, foot * 0.12);
  const barGeo = new BoxGeometry(barW, 0.06, 1);
  // Tick: a short and a long flat bar joined at the vertex, a check lying on its side (bar length along local x,
  // thickness along y, width along z). Directions are in the xz plane with -z as "up"; each bar starts half a width
  // behind the vertex so the joint is closed. The pair is centred on its bounding box (tickOffX/Z).
  const tickShortLen = foot * 0.26;
  const tickLongLen = foot * 0.5;
  const tickW = Math.max(0.16, foot * 0.075);
  const tickH = Math.max(0.08, foot * 0.035);
  const tickShortDir = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };
  const tickLongDir = { x: 0.55, z: -0.835 };
  const tickOffX = -(tickShortDir.x * tickShortLen + tickLongDir.x * tickLongLen) / 2;
  const tickOffZ = -(tickShortDir.z * tickShortLen + tickLongDir.z * tickLongLen) / 2;
  const tickShortGeo = new BoxGeometry(tickShortLen + tickW / 2, tickH, tickW);
  const tickLongGeo = new BoxGeometry(tickLongLen + tickW / 2, tickH, tickW);
  // Flag: pole ~0.6 x foot plus a triangular pennant.
  const poleH = foot * 0.6;
  const poleT = Math.max(0.06, foot * 0.025);
  const poleGeo = new BoxGeometry(poleT, poleH, poleT);
  const pennW = foot * 0.38;
  const pennH = foot * 0.22;
  const pennTop = poleH;
  const pennBot = poleH - pennH;
  const pennShape = new Shape();
  pennShape.moveTo(poleT / 2, pennTop);
  pennShape.lineTo(poleT / 2, pennBot);
  pennShape.lineTo(poleT / 2 + pennW, (pennTop + pennBot) / 2);
  pennShape.closePath();
  const flagGeo = new ShapeGeometry(pennShape);

  // Night: the scan is light. Emissive blue (palette.line) for verify and the cross-model sheet, translucent so the
  // lots show through it; the orchestrator's ring is warm. Status markers glow too (shape still carries the meaning).
  const verifyMat = new MeshLambertMaterial({ color: palette.line, emissive: palette.line, emissiveIntensity: 0.9, transparent: true, opacity: 0.85, depthWrite: false });
  const orchMat = new MeshLambertMaterial({ color: palette.lightWarm, emissive: palette.lightWarm, emissiveIntensity: 0.8, transparent: true, opacity: 0.9, depthWrite: false });
  const barMat = new MeshLambertMaterial({ color: palette.line, emissive: palette.line, emissiveIntensity: 1.0, transparent: true, opacity: 0.55, depthWrite: false });
  const okMat = new MeshLambertMaterial({ color: palette.ok, emissive: palette.ok, emissiveIntensity: 0.6 });
  const failMat = new MeshLambertMaterial({ color: palette.fail, emissive: palette.fail, emissiveIntensity: 0.6, side: DoubleSide });

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
  crossBar.userData.noShadowCast = true;
  crossBar.visible = false;
  root.add(verifyRing);
  root.add(orchRing);
  root.add(crossBar);

  // --- Per-original-lot markers.
  const n = origIdx.length;
  const markers: Group[] = [];
  const ticks: Group[] = [];
  const flags: Group[] = [];
  for (let k = 0; k < n; k++) {
    const li = origIdx[k];
    if (li === undefined) continue;
    const lot = layout.lots[li];
    if (lot === undefined) continue;
    const g = new Group();
    g.name = 'scan-marker-' + lot.slug;
    g.rotation.y = MARKER_YAW;
    const tick = new Group();
    tick.name = 'scan-tick-' + lot.slug;
    tick.rotation.y = TICK_YAW - MARKER_YAW; // the marker group is yawed MARKER_YAW; net yaw is TICK_YAW
    const shortBar = new Mesh(tickShortGeo, okMat);
    shortBar.rotation.y = -Math.atan2(tickShortDir.z, tickShortDir.x);
    shortBar.position.set(
      tickOffX + tickShortDir.x * (tickShortLen / 2 - tickW / 4), 0, tickOffZ + tickShortDir.z * (tickShortLen / 2 - tickW / 4));
    const longBar = new Mesh(tickLongGeo, okMat);
    longBar.rotation.y = -Math.atan2(tickLongDir.z, tickLongDir.x);
    longBar.position.set(
      tickOffX + tickLongDir.x * (tickLongLen / 2 - tickW / 4), 0, tickOffZ + tickLongDir.z * (tickLongLen / 2 - tickW / 4));
    tick.add(shortBar);
    tick.add(longBar);
    tick.visible = false;
    const flag = new Group();
    flag.name = 'scan-flag-' + lot.slug;
    const pole = new Mesh(poleGeo, failMat);
    pole.position.y = poleH / 2;
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
      // Cross-model review with a null target covers only the code the run
      // produced: the new-lot slots (+ margin), extended to the annex while an
      // extra is building. No allocation: pick the precomputed rect by state.
      let ex0 = baseEx0, ex1 = baseEx1, ez0 = baseEz0, ez1 = baseEz1;
      if (useAnnexSwitch) {
        let building = false;
        const xn = state.extras.length;
        for (let j = 0; j < xn; j++) {
          const x = state.extras[j];
          if (x !== undefined && x.build > 0) {
            building = true;
            break;
          }
        }
        if (building) {
          ex0 = combEx0; ex1 = combEx1; ez0 = combEz0; ez1 = combEz1;
        }
      }
      const spanX = ex1 - ex0;
      const spanZ = ez1 - ez0;
      crossBar.position.set(ex0 + spanX * p, maxH + BAR_LIFT + bob, (ez0 + ez1) / 2);
      crossBar.scale.z = spanZ > 0.001 ? spanZ : 1;
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
      let b = w.build;
      if (!(b >= 0)) b = 0;
      else if (b > 1) b = 1;
      g.position.set(pose.x, pose.y + lot.height * b + MARKER_LIFT + bob, pose.z);
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
    tickShortGeo.dispose();
    tickLongGeo.dispose();
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
