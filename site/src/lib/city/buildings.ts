// SwarmKit City buildings: instanced boxes for every lot, driven only by StageState.
//
// - main: one box instance per original lot, height lot.height * workers[i].build,
//   lane colour (palette.laneAgy / palette.laneOpencode via setColorAt), standing
//   where lotPoseAt(layout, i, merge) says (shared with the merge part, so the two
//   never drift apart);
// - rework: a thin wider band on top of each main box, height rising with
//   workers[i].rework in the rework lane's colour (the worker's own lane once the
//   pass ends and reworkLane clears);
// - extras: a separate InstancedMesh with a low flat-roofed annex silhouette
//   (body + overhanging roof slab in one geometry), growing with extras[j].build.
//
// Status (passed / flagged) is left to the scan part, which pairs colour with a
// shape; buildings only uses lane colours plus box height and the rework band, so
// nothing here reads as a verdict. Same state gives the same matrices: update is
// allocation-free and reads layout (fixed at creation) plus state only.
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { lotPoseAt } from './lots.ts';
import type { CityPalette, CityPart, LotLayout, StageState } from './types.ts';

/** Rework band height as a fraction of the lot's finished height at rework = 1. */
const REWORK_FRACTION = 0.2;
/** Rework band footprint overhang relative to the main box, so it reads as a cap. */
const REWORK_OVERHANG = 1.08;
/** Annex geometry (unit height, base at y = 0): body takes this fraction, roof the rest. */
const ANNEX_BODY = 0.82;
const ANNEX_ROOF = 0.18;
const ANNEX_ROOF_OVERHANG = 1.18;

/** Low flat-roofed annex silhouette: a unit box body with an overhanging roof slab. */
function buildAnnexGeometry(): BufferGeometry {
  const body = new BoxGeometry(1, ANNEX_BODY, 1);
  body.translate(0, ANNEX_BODY / 2, 0);
  const roof = new BoxGeometry(ANNEX_ROOF_OVERHANG, ANNEX_ROOF, ANNEX_ROOF_OVERHANG);
  roof.translate(0, ANNEX_BODY + ANNEX_ROOF / 2, 0);
  const bodyFlat = body.toNonIndexed();
  const roofFlat = roof.toNonIndexed();
  body.dispose();
  roof.dispose();
  const parts: BufferGeometry[] = [bodyFlat, roofFlat];
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].getAttribute('position').count;
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
  let v = 0;
  for (let i = 0; i < parts.length; i++) {
    const pos = parts[i].getAttribute('position');
    const nor = parts[i].getAttribute('normal');
    const uv = parts[i].getAttribute('uv');
    for (let k = 0; k < pos.count; k++) {
      positions[v * 3] = pos.getX(k);
      positions[v * 3 + 1] = pos.getY(k);
      positions[v * 3 + 2] = pos.getZ(k);
      normals[v * 3] = nor.getX(k);
      normals[v * 3 + 1] = nor.getY(k);
      normals[v * 3 + 2] = nor.getZ(k);
      uvs[v * 2] = uv.getX(k);
      uvs[v * 2 + 1] = uv.getY(k);
      v++;
    }
  }
  bodyFlat.dispose();
  roofFlat.dispose();
  const out = new BufferGeometry();
  out.setAttribute('position', new Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  out.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  return out;
}

export function createBuildings(layout: LotLayout, palette: CityPalette): CityPart {
  const mainIndex: number[] = [];
  const extraIndex: number[] = [];
  for (let i = 0; i < layout.lots.length; i++) {
    if (layout.lots[i].extra) extraIndex.push(i);
    else mainIndex.push(i);
  }
  const nMain: number = mainIndex.length;
  const nExtra: number = extraIndex.length;

  const mainW: number[] = [];
  const mainD: number[] = [];
  const mainH: number[] = [];
  const mainAgy: boolean[] = [];
  for (let k = 0; k < nMain; k++) {
    const lot = layout.lots[mainIndex[k]];
    mainW.push(lot.w);
    mainD.push(lot.d);
    mainH.push(lot.height);
    mainAgy.push(lot.lane === 'agy');
  }
  const extraW: number[] = [];
  const extraD: number[] = [];
  const extraH: number[] = [];
  const extraAgy: boolean[] = [];
  for (let j = 0; j < nExtra; j++) {
    const lot = layout.lots[extraIndex[j]];
    extraW.push(lot.w);
    extraD.push(lot.d);
    extraH.push(lot.height);
    extraAgy.push(lot.lane === 'agy');
  }

  const agyHex: string = palette.laneAgy;
  const opencodeHex: string = palette.laneOpencode;

  // Unit boxes with the base at y = 0: instance scale (w, h, d) grows them from the ground.
  const mainGeo = new BoxGeometry(1, 1, 1);
  mainGeo.translate(0, 0.5, 0);
  const reworkGeo = new BoxGeometry(1, 1, 1);
  reworkGeo.translate(0, 0.5, 0);
  const extraGeo: BufferGeometry = buildAnnexGeometry();

  // White base so the per-instance palette lane colours show unmodified.
  const mainMat = new MeshLambertMaterial({ color: 0xffffff });
  const reworkMat = new MeshLambertMaterial({ color: 0xffffff });
  const extraMat = new MeshLambertMaterial({ color: 0xffffff });

  const root = new Group();
  root.name = 'buildings';
  const mainMesh = new InstancedMesh(mainGeo, mainMat, nMain > 0 ? nMain : 1);
  mainMesh.name = 'buildings-main';
  const reworkMesh = new InstancedMesh(reworkGeo, reworkMat, nMain > 0 ? nMain : 1);
  reworkMesh.name = 'buildings-rework';
  const extraMesh = new InstancedMesh(extraGeo, extraMat, nExtra > 0 ? nExtra : 1);
  extraMesh.name = 'buildings-extras';
  mainMesh.count = nMain;
  reworkMesh.count = nMain;
  extraMesh.count = nExtra;
  mainMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  reworkMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  extraMesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mainMesh.frustumCulled = false;
  reworkMesh.frustumCulled = false;
  extraMesh.frustumCulled = false;
  root.add(mainMesh);
  root.add(reworkMesh);
  root.add(extraMesh);

  const col = new Color();
  for (let k = 0; k < nMain; k++) {
    if (mainAgy[k]) col.set(agyHex);
    else col.set(opencodeHex);
    mainMesh.setColorAt(k, col);
    reworkMesh.setColorAt(k, col);
  }
  for (let j = 0; j < nExtra; j++) {
    if (extraAgy[j]) col.set(agyHex);
    else col.set(opencodeHex);
    extraMesh.setColorAt(j, col);
  }
  const seeded: InstancedMesh[] = [mainMesh, reworkMesh, extraMesh];
  for (let i = 0; i < seeded.length; i++) {
    seeded[i].instanceMatrix.needsUpdate = true;
    const ic = seeded[i].instanceColor;
    if (ic !== null) ic.needsUpdate = true;
  }

  // Scratch state reused every frame so update allocates nothing.
  const pose: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  const posV = new Vector3();
  const sclV = new Vector3();
  const quat = new Quaternion();
  const mat = new Matrix4();

  function update(state: StageState, dt: number): void {
    void dt;
    for (let k = 0; k < nMain; k++) {
      const worker = state.workers[k];
      const build = worker.build <= 0 ? 0 : worker.build >= 1 ? 1 : worker.build;
      const merge = worker.merge <= 0 ? 0 : worker.merge >= 1 ? 1 : worker.merge;
      const rework = worker.rework <= 0 ? 0 : worker.rework >= 1 ? 1 : worker.rework;
      lotPoseAt(layout, mainIndex[k], merge, pose);
      const h = mainH[k] * build;
      posV.set(pose.x, pose.y, pose.z);
      sclV.set(mainW[k], h, mainD[k]);
      mat.compose(posV, quat, sclV);
      mainMesh.setMatrixAt(k, mat);
      const bandH = mainH[k] * REWORK_FRACTION * rework;
      posV.set(pose.x, pose.y + h, pose.z);
      sclV.set(mainW[k] * REWORK_OVERHANG, bandH, mainD[k] * REWORK_OVERHANG);
      mat.compose(posV, quat, sclV);
      reworkMesh.setMatrixAt(k, mat);
      const lane = worker.reworkLane !== null ? worker.reworkLane : worker.lane;
      if (lane === 'agy') col.set(agyHex);
      else col.set(opencodeHex);
      reworkMesh.setColorAt(k, col);
    }
    for (let j = 0; j < nExtra; j++) {
      const extra = state.extras[j];
      const build = extra.build <= 0 ? 0 : extra.build >= 1 ? 1 : extra.build;
      const merge = extra.merge <= 0 ? 0 : extra.merge >= 1 ? 1 : extra.merge;
      lotPoseAt(layout, extraIndex[j], merge, pose);
      const h = extraH[j] * build;
      posV.set(pose.x, pose.y, pose.z);
      sclV.set(extraW[j], h, extraD[j]);
      mat.compose(posV, quat, sclV);
      extraMesh.setMatrixAt(j, mat);
    }
    mainMesh.instanceMatrix.needsUpdate = true;
    reworkMesh.instanceMatrix.needsUpdate = true;
    extraMesh.instanceMatrix.needsUpdate = true;
    const ric = reworkMesh.instanceColor;
    if (ric !== null) ric.needsUpdate = true;
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.clear();
    mainGeo.dispose();
    reworkGeo.dispose();
    extraGeo.dispose();
    mainMat.dispose();
    reworkMat.dispose();
    extraMat.dispose();
  }

  return { object: root, update, dispose };
}
