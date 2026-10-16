import * as THREE from 'three';
import type { CityPalette, CityPart, LotLayout, Rect, StageState } from './types.ts';

const SEGMENTS_PER_RECT = 4;
const VERTS_PER_RECT = SEGMENTS_PER_RECT * 2;
const BASE_Y = 0.05;
const LOT_LIFT_Y = 0.06;

function rectPositions(rect: Rect, y: number): Float32Array {
  const x0 = rect.x - rect.w / 2;
  const x1 = rect.x + rect.w / 2;
  const z0 = rect.z - rect.d / 2;
  const z1 = rect.z + rect.d / 2;
  const out = new Float32Array(VERTS_PER_RECT * 3);
  out[0] = x0;
  out[1] = y;
  out[2] = z0;
  out[3] = x1;
  out[4] = y;
  out[5] = z0;
  out[6] = x1;
  out[7] = y;
  out[8] = z0;
  out[9] = x1;
  out[10] = y;
  out[11] = z1;
  out[12] = x1;
  out[13] = y;
  out[14] = z1;
  out[15] = x0;
  out[16] = y;
  out[17] = z1;
  out[18] = x0;
  out[19] = y;
  out[20] = z1;
  out[21] = x0;
  out[22] = y;
  out[23] = z0;
  return out;
}

function makeOutline(rect: Rect, mat: THREE.Material): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(rectPositions(rect, BASE_Y), 3));
  geo.setDrawRange(0, 0);
  return new THREE.LineSegments(geo, mat);
}

export function createBlueprint(layout: LotLayout, palette: CityPalette): CityPart {
  const group = new THREE.Group();
  const lineColour = new THREE.Color(palette.line);
  const plotMat = new THREE.LineBasicMaterial({ color: lineColour });
  const lotMat = new THREE.LineBasicMaterial({ color: lineColour, transparent: true, opacity: 0 });

  const plotLines = makeOutline(layout.plot, plotMat);
  plotLines.userData.kind = 'plot';
  group.add(plotLines);
  const plotGeo = plotLines.geometry as THREE.BufferGeometry;

  const lotLines: THREE.LineSegments[] = [];
  const lotGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < layout.lots.length; i++) {
    const lot = layout.lots[i];
    if (lot.extra) continue;
    const lines = makeOutline(lot, lotMat);
    lines.userData.kind = 'lot';
    lines.userData.slug = lot.slug;
    group.add(lines);
    lotLines.push(lines);
    lotGeos.push(lines.geometry as THREE.BufferGeometry);
  }

  const annexLines: THREE.LineSegments[] = [];
  const annexGeos: THREE.BufferGeometry[] = [];
  for (let j = 0; j < layout.annex.length; j++) {
    const slot = layout.annex[j];
    const lines = makeOutline(slot, lotMat);
    lines.userData.kind = 'annex';
    lines.userData.slug = slot.slug;
    lines.visible = false;
    group.add(lines);
    annexLines.push(lines);
    annexGeos.push(lines.geometry as THREE.BufferGeometry);
  }

  let disposed = false;

  function update(state: StageState, dt: number): void {
    void dt;
    let bp = state.blueprint;
    if (bp < 0) bp = 0;
    else if (bp > 1) bp = 1;
    let sp = state.split;
    if (sp < 0) sp = 0;
    else if (sp > 1) sp = 1;
    const draw = Math.floor(bp * SEGMENTS_PER_RECT) * 2;
    plotGeo.setDrawRange(0, draw);
    for (let i = 0; i < lotGeos.length; i++) lotGeos[i].setDrawRange(0, draw);
    lotMat.opacity = sp;
    for (let i = 0; i < lotLines.length; i++) lotLines[i].position.y = sp * LOT_LIFT_Y;
    for (let i = 0; i < annexGeos.length; i++) {
      let build = 0;
      if (i < state.extras.length) build = state.extras[i].build;
      if (build > 0) {
        annexLines[i].visible = true;
        annexGeos[i].setDrawRange(0, draw);
      } else {
        annexLines[i].visible = false;
        annexGeos[i].setDrawRange(0, 0);
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    plotGeo.dispose();
    for (let i = 0; i < lotGeos.length; i++) lotGeos[i].dispose();
    for (let i = 0; i < annexGeos.length; i++) annexGeos[i].dispose();
    plotMat.dispose();
    lotMat.dispose();
  }

  return { object: group, update, dispose };
}
