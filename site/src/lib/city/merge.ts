// SwarmKit City, merge beat: the lots' footprints lift out of the blueprint plot and slide into their slots
// in the existing city block while the block's streets draw in. Placeholder look: flat matte plates and strips.
//
// - The block ground plate (layout.cityBlock) is always visible, a dark night asphalt close to the board.
// - Each original lot gets a flat footprint plate in its lane colour (shown once state.split > 0). It moves from lots[i] to block[i] with
//   state.workers[i].merge through lotPoseAt from lots.ts, the same function the buildings part uses, so the
//   plate and its building never drift apart.
// - Each road in layout.roads is a flat strip a touch under the block ground with a
//   hairline centre line in the line colour, faintly emissive, so streets read as streets at night, not bars. Block streets grow along their length with
//   state.mergeAll (scale 0 = invisible, 1 = full); annex streets grow with their row's extras merge instead.
// - Annex plates sit in their annex slots and grow with extras[j].merge (extras never move, only join).
// - Status is never colour alone: a passed lot carries a flat tick bar, a flagged lot a standing cone.
// - update() is allocation-free and a pure function of (state, dt): the same state always gives the same
//   picture, so scrolling back rewinds exactly. dt is accepted for the CityPart contract but unused: nothing
//   here idles, everything is driven by state.
import { BoxGeometry, Color, ConeGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry, Material } from 'three';
import { ANNEX_SIZE, ROAD_W, lotPoseAt } from './lots.ts';
import type { CityPalette, CityPart, CreateMerge, LotLayout, StageState } from './types.ts';

/** Footprint plate thickness (m). */
const PLATE_H = 0.12;
/** Road strip thickness (m). */
const ROAD_H = 0.03;
/** Road surface at night: dark asphalt a touch under the block ground, faintly self-lit in the line colour. */
const ROAD_ASPHALT = '#121825';
const ROAD_GLOW = 0.06;
/** Centre line: width (m) and share of the road's length; the line colour, glowing faintly so streets read at night without blooming. */
const CENTRE_W = 0.07;
const CENTRE_LEN = 0.94;
const CENTRE_GLOW = 0.55;
/** Lane plates and status markers are self-lit, so a lot reads as lit ground, not a flat tile. */
const PLATE_GLOW = 0.85;
/** A plate glows this much before its lot is built; the rest comes with the build. */
const PLATE_IDLE = 0.15;
const MARK_GLOW = 0.4;
/** City-block ground plate thickness (m); its top sits at y = 0. */
const GROUND_H = 0.3;
/** The block ground plate at night: dark asphalt close to the board's on-screen colour, breathing the line colour at low intensity so the old town reads as streets, not a hole. */
const GROUND_ASPHALT = '#171f2e';
const GROUND_GLOW = 0.04;

type PlateMesh = Mesh<BoxGeometry, MeshLambertMaterial>;

export const createMerge: CreateMerge = (layout: LotLayout, palette: CityPalette): CityPart => {
  const root = new Group();
  root.name = 'merge';
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];

  const line = new Color(palette.line);
  const groundMat = new MeshLambertMaterial({ color: new Color(GROUND_ASPHALT), emissive: line.clone(), emissiveIntensity: GROUND_GLOW });
  const roadMat = new MeshLambertMaterial({ color: new Color(ROAD_ASPHALT), emissive: line.clone(), emissiveIntensity: ROAD_GLOW });
  const centreMat = new MeshLambertMaterial({ color: line.clone(), emissive: line.clone(), emissiveIntensity: CENTRE_GLOW });
  const glowing = (hex: string, k: number) => new MeshLambertMaterial({ color: hex, emissive: hex, emissiveIntensity: k });
  const agyMat = glowing(palette.laneAgy, PLATE_GLOW);
  const opencodeMat = glowing(palette.laneOpencode, PLATE_GLOW);
  const okMat = glowing(palette.ok, MARK_GLOW);
  const failMat = glowing(palette.fail, MARK_GLOW);
  materials.push(groundMat, roadMat, centreMat, agyMat, opencodeMat, okMat, failMat);

  // The existing city block's ground: always visible, never moves.
  const groundGeo = new BoxGeometry(layout.cityBlock.w, GROUND_H, layout.cityBlock.d);
  geometries.push(groundGeo);
  const ground = new Mesh(groundGeo, groundMat);
  ground.position.set(layout.cityBlock.x, -GROUND_H / 2, layout.cityBlock.z);
  ground.userData.kind = 'block';
  root.add(ground);

  // Original lots come first in layout.lots, extras after; state.workers lines up with the originals.
  const origIndex: number[] = [];
  const extraIndex: number[] = [];
  for (let i = 0; i < layout.lots.length; i++) {
    if (layout.lots[i].extra) extraIndex.push(i);
    else origIndex.push(i);
  }

  // Shared status markers: a flat tick bar (passed) and a standing cone (flagged). Shape, never colour alone.
  const tickGeo = new BoxGeometry(1.6, 0.06, 0.34);
  const flagGeo = new ConeGeometry(0.22, 0.6, 4);
  geometries.push(tickGeo, flagGeo);

  const footprintMeshes: PlateMesh[] = [];
  const plateMats: MeshLambertMaterial[] = [];
  const annexMats: MeshLambertMaterial[] = [];
  const tickMeshes: PlateMesh[] = [];
  const flagMeshes: Array<Mesh<ConeGeometry, MeshLambertMaterial>> = [];
  for (let f = 0; f < origIndex.length; f++) {
    const lot = layout.lots[origIndex[f]];
    const geo = new BoxGeometry(lot.w, PLATE_H, lot.d);
    geometries.push(geo);
    // Own material per plate: it lights up with its lot's build (see update).
    const plateMat = (lot.lane === 'agy' ? agyMat : opencodeMat).clone();
    materials.push(plateMat);
    plateMats.push(plateMat);
    const mesh: PlateMesh = new Mesh(geo, plateMat);
    mesh.position.set(lot.x, PLATE_H / 2, lot.z);
    mesh.userData.kind = 'footprint';
    mesh.userData.slug = lot.slug;
    const tick: PlateMesh = new Mesh(tickGeo, okMat);
    tick.rotation.y = Math.PI / 4;
    tick.position.y = PLATE_H / 2 + 0.03;
    tick.visible = false;
    const flag: Mesh<ConeGeometry, MeshLambertMaterial> = new Mesh(flagGeo, failMat);
    flag.position.y = PLATE_H / 2 + 0.3;
    flag.visible = false;
    mesh.add(tick, flag);
    root.add(mesh);
    footprintMeshes.push(mesh);
    tickMeshes.push(tick);
    flagMeshes.push(flag);
  }

  // Annex streets run along x at z = slot.z - ANNEX_SIZE/2 - ROAD_W/2; find them so they can follow their
  // row's extras merge while every other road follows mergeAll.
  const annexRows: number[] = [];
  for (let a = 0; a < layout.annex.length; a++) {
    if (!annexRows.includes(layout.annex[a].z)) annexRows.push(layout.annex[a].z);
  }
  const roadAnnexRow: number[] = [];
  for (let r = 0; r < layout.roads.length; r++) {
    const seg = layout.roads[r];
    let row = -1;
    if (seg.z1 === seg.z2 || Math.abs(seg.z1 - seg.z2) < 1e-12) {
      for (let a = 0; a < annexRows.length; a++) {
        if (Math.abs(seg.z1 - (annexRows[a] - ANNEX_SIZE / 2 - ROAD_W / 2)) < 1e-9) {
          row = a;
          break;
        }
      }
    }
    roadAnnexRow.push(row);
  }
  // Extra indices (into state.extras) per annex row.
  const rowExtras: number[][] = annexRows.map(() => []);
  for (let j = 0; j < extraIndex.length; j++) {
    const slotZ = layout.block[extraIndex[j]].z;
    for (let a = 0; a < annexRows.length; a++) {
      if (Math.abs(slotZ - annexRows[a]) < 1e-9) {
        rowExtras[a].push(j);
        break;
      }
    }
  }

  // One shared unit-length centre-line box, stretched per road; it rides on its road, so it grows with it.
  const centreGeo = new BoxGeometry(1, 0.01, CENTRE_W);
  geometries.push(centreGeo);
  const roadMeshes: PlateMesh[] = [];
  const roadX1: number[] = [];
  const roadZ1: number[] = [];
  const roadDX: number[] = [];
  const roadDZ: number[] = [];
  const roadLen: number[] = [];
  const roadY: number[] = [];
  for (let r = 0; r < layout.roads.length; r++) {
    const seg = layout.roads[r];
    const dx = seg.x2 - seg.x1;
    const dz = seg.z2 - seg.z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    const safeLen = len > 1e-9 ? len : 1e-6;
    const geo = new BoxGeometry(safeLen, ROAD_H, seg.width);
    geometries.push(geo);
    const mesh: PlateMesh = new Mesh(geo, roadMat);
    mesh.rotation.y = Math.atan2(-dz, dx);
    const y = ROAD_H / 2 + (r % 8) * 0.0012;
    mesh.position.set(seg.x1, y, seg.z1);
    mesh.scale.x = 0;
    mesh.visible = false;
    mesh.userData.kind = 'road';
    mesh.userData.annex = roadAnnexRow[r] >= 0;
    const centre = new Mesh(centreGeo, centreMat);
    centre.scale.x = safeLen * CENTRE_LEN;
    centre.position.y = ROAD_H / 2 + 0.005;
    mesh.add(centre);
    root.add(mesh);
    roadMeshes.push(mesh);
    roadX1.push(seg.x1);
    roadZ1.push(seg.z1);
    roadDX.push(dx / safeLen);
    roadDZ.push(dz / safeLen);
    roadLen.push(len);
    roadY.push(y);
  }

  // Annex plates: built in place, growing with their extra's merge.
  const annexMeshes: PlateMesh[] = [];
  for (let j = 0; j < extraIndex.length; j++) {
    const lot = layout.lots[extraIndex[j]];
    const geo = new BoxGeometry(lot.w, PLATE_H, lot.d);
    geometries.push(geo);
    const plateMat = (lot.lane === 'agy' ? agyMat : opencodeMat).clone();
    materials.push(plateMat);
    annexMats.push(plateMat);
    const mesh: PlateMesh = new Mesh(geo, plateMat);
    mesh.position.set(lot.x, PLATE_H / 2, lot.z);
    mesh.scale.set(0, 1, 0);
    mesh.visible = false;
    mesh.userData.kind = 'annex';
    mesh.userData.slug = lot.slug;
    root.add(mesh);
    annexMeshes.push(mesh);
  }

  // Scratch pose for lotPoseAt, reused every frame so update() never allocates.
  const pose = { x: 0, y: 0, z: 0 };

  function update(state: StageState, _dt: number): void {
    for (let f = 0; f < footprintMeshes.length; f++) {
      const w = state.workers[f];
      if (w === undefined) continue;
      const m = w.merge <= 0 ? 0 : w.merge >= 1 ? 1 : w.merge;
      lotPoseAt(layout, origIndex[f], m, pose);
      footprintMeshes[f].position.set(pose.x, pose.y + PLATE_H / 2, pose.z);
      // Lots exist only once the plan splits the plot: before that the plot is an empty blueprint.
      footprintMeshes[f].visible = state.split > 0;
      plateMats[f].emissiveIntensity = PLATE_IDLE + (PLATE_GLOW - PLATE_IDLE) * (w.build <= 0 ? 0 : w.build >= 1 ? 1 : w.build);
      tickMeshes[f].visible = w.scan === 'passed';
      flagMeshes[f].visible = w.scan === 'flagged';
    }
    let all = state.mergeAll;
    all = all <= 0 ? 0 : all >= 1 ? 1 : all;
    for (let r = 0; r < roadMeshes.length; r++) {
      const row = roadAnnexRow[r];
      let s = all;
      if (row >= 0) {
        s = 0;
        const members = rowExtras[row];
        for (let k = 0; k < members.length; k++) {
          const xs = state.extras[members[k]];
          const em = xs === undefined ? 0 : xs.merge;
          const c = em <= 0 ? 0 : em >= 1 ? 1 : em;
          if (c > s) s = c;
        }
      }
      const mesh = roadMeshes[r];
      mesh.scale.x = s;
      mesh.visible = s > 0;
      mesh.position.set(
        roadX1[r] + roadDX[r] * roadLen[r] * s * 0.5,
        roadY[r],
        roadZ1[r] + roadDZ[r] * roadLen[r] * s * 0.5,
      );
    }
    for (let j = 0; j < annexMeshes.length; j++) {
      const xs = state.extras[j];
      if (xs === undefined) continue;
      const m = xs.merge <= 0 ? 0 : xs.merge >= 1 ? 1 : xs.merge;
      const mesh = annexMeshes[j];
      mesh.scale.set(m, 1, m);
      mesh.visible = m > 0;
      annexMats[j].emissiveIntensity = PLATE_IDLE + (PLATE_GLOW - PLATE_IDLE) * (xs.build <= 0 ? 0 : xs.build >= 1 ? 1 : xs.build);
    }
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (let i = 0; i < geometries.length; i++) geometries[i].dispose();
    for (let i = 0; i < materials.length; i++) materials[i].dispose();
  }

  return { object: root, update, dispose };
};
