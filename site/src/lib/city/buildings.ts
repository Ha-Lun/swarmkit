// SwarmKit City buildings: instanced boxes for every lot, driven only by StageState.
//
// - main: one box instance per original lot, height lot.height * workers[i].build,
//   lane colour (palette.laneAgy / palette.laneOpencode via setColorAt), standing
//   where lotPoseAt(layout, i, merge) says (shared with the merge part, so the two
//   never drift apart);
// - rework: with the kit, the scaffold cage around the body while a pass runs (reworkLane set), top rail in the
//   rework lane's colour; without the kit, a thin wider band on top of each main box, height rising with
//   workers[i].rework in the rework lane's colour (the worker's own lane once the pass ends and reworkLane clears);
// - existing: the code that existed before the run (layout.existing), decorative and always visible, one static
//   instance per building in a neutral warm grey derived from palette.paper and palette.ink (never a lane colour);
// - main boxes stand on a setback footprint (FOOTPRINT of the lot, centred); the lot plates (merge part) keep the
//   full lot size, so a new building reads as a building on its parcel;
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
  DataTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  NearestFilter,
  Quaternion,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { Material, WebGLProgramParametersWithUniforms } from 'three';
import { kitPartGeometries } from './kit.ts';
import type { Kit } from './kit.ts';
import { lotPoseAt } from './lots.ts';
import type { CityPalette, CityPart, LotLayout, StageState } from './types.ts';

/** Building footprint as a fraction of its lot (centred): the setback from the parcel edge. */
export const FOOTPRINT = 0.7;
/**
 * Existing-city colour at night: the (light) ink token dimmed to a cool slate with a touch of the blueprint blue, and
 * a small per-building lightness spread. Dim, but light enough for the key and rim to give it edges.
 */
const OLD_DIM = 0.36;
const OLD_BLUE = 0.16;
const OLD_SPREAD = 0.22;
const oldBaseColour = (palette: CityPalette): Color => new Color(palette.ink).multiplyScalar(OLD_DIM).lerp(new Color(palette.line), OLD_BLUE);
/**
 * Night glow (no bloom). Windows: the kit's glass swatches emit --light-warm, and a per-window hash decides which are
 * lit against the lot's `aGlow` (0..1, the share of windows lit). Old city: a dim glow, few lit. New lots: a bright
 * glow whose share of lit windows follows the lot's build (built new lots are the brightest things in the
 * scene). Lane parts of new lots self-illuminate in their lane colour.
 */
const WIN_GLOW_NEW = 3.1;
const WIN_GLOW_OLD = 1.2;
const LANE_GLOW_NEW = 1.0;
/** Share of windows lit at the finished state of a new lot, and the base share while it is only started. */
const LIT_MAX = 0.93;
const LIT_MIN = 0.12;
/** Share of windows lit in the existing city: seeded per building, between these. */
const OLD_LIT_MIN = 0.1;
const OLD_LIT_MAX = 0.3;
/** Window hash cells per metre (x, y, z) of the authored module: about one window per cell. */
const WIN_CELLS = 'vec3( 2.4, 5.0, 2.4 )';
/** Palette swatches that glow: glass, glass_hi and the lantern lamp (public/models/README.md). */
const GLOW_SWATCHES = [10, 11, 15];

/** An 8 x 8 emissive mask in the kit palette's layout: white on the glowing swatches, black elsewhere. */
function glowMask(): DataTexture {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) {
    const row = 7 - Math.floor(i / 8); // glTF v runs up: swatch row r is data row 7 - r
    const o = (row * 8 + (i % 8)) * 4;
    const on = GLOW_SWATCHES.includes(i) ? 255 : 0;
    data[o] = on; data[o + 1] = on; data[o + 2] = on; data[o + 3] = 255;
  }
  const tex = new DataTexture(data, 8, 8, RGBAFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/** Add the per-instance `aGlow` attribute and the varyings to a standard material's program. */
function patchGlow(mat: Material, tag: string, fragment: string): void {
  mat.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec3 vGlowLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow;\nvGlowLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying vec3 vGlowLocal;')
      .replace('#include <emissivemap_fragment>', fragment);
  };
  mat.customProgramCacheKey = () => tag;
}

/** Window material: the kit material (map and all) plus the glow mask, emitting warm light on lit windows. */
function windowMaterial(base: Material, mask: DataTexture, warm: Color, intensity: number): Material {
  const m = base.clone() as Material & { emissive: Color; emissiveIntensity: number; emissiveMap: DataTexture | null };
  m.emissive = warm.clone();
  m.emissiveIntensity = intensity;
  m.emissiveMap = mask;
  patchGlow(m, 'city-windows', `
    vec3 gCell = floor( vGlowLocal * ${WIN_CELLS} );
    float gHash = fract( sin( dot( gCell, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
    totalEmissiveRadiance *= texture2D( emissiveMap, vEmissiveMapUv ).rgb * step( gHash, vGlow );`);
  return m;
}

/** Lane material for new lots: white base (instance colour tints it), self-lit in that colour by `aGlow`. */
function laneGlowMaterial(base: Material, intensity: number): Material {
  const m = base.clone() as Material & { color: Color; emissive: Color; emissiveIntensity: number };
  m.color.set(0xffffff);
  m.emissive = new Color(0xffffff); // the `emissive` uniform is this times the intensity: a plain grey factor here
  m.emissiveIntensity = intensity;
  patchGlow(m, 'city-lane', 'totalEmissiveRadiance = diffuseColor.rgb * emissive * vGlow;');
  return m;
}

/** Give an instanced mesh its own geometry clone with a per-instance `aGlow` attribute (the source stays shared). */
function addGlow(mesh: InstancedMesh, count: number): InstancedBufferAttribute {
  const geo = mesh.geometry.clone();
  const attr = new InstancedBufferAttribute(new Float32Array(Math.max(1, count)), 1);
  attr.setUsage(DynamicDrawUsage);
  geo.setAttribute('aGlow', attr);
  mesh.geometry = geo;
  return attr;
}

/** The share of windows lit for a new lot at this build (0 before it exists). */
const litAt = (build: number): number => (build <= 0 ? 0 : LIT_MIN + (LIT_MAX - LIT_MIN) * build);
/** Rework band height as a fraction of the lot's finished height at rework = 1. */
const REWORK_FRACTION = 0.2;
/** Below this height (m) an instance is collapsed to nothing rather than drawn flat. */
const MIN_H = 1e-3;
/**
 * Scaffold poles and braces: a warm, darker steel multiplier (the kit steel is a cool light grey, #9ca5ae) pulled 40%
 * of the way to the rework lane's colour, so the thin cage reads as a dark warm frame against the pale bodies instead
 * of a light grey one. (Brighter gains or a larger lane mix washed out to grey again in testing: the dark steel
 * swatch eats the saturation.)
 */
const SCAF_STEEL = new Color(0.78, 0.7, 0.6);
const SCAF_LANE_MIX = 0.4;
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

/** Seeded 32-bit hash of a slug (FNV-1a): the only randomness source, deterministic per slug. */
export function hashSlug(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick one of `count` variants from a slug's hash. Pure: the same slug always picks the same variant. */
export function pickVariant(slug: string, count: number): number {
  if (!(count > 0)) return 0;
  return hashSlug(slug) % count;
}

/** Authored kit module sizes (m, from public/models/README.md). */
const BODY_AUTHOR = 2.52;
const ANNEX_AUTHOR = 1.5;
/** Kit body/roof module names in variant order. */
const BODY_NAMES = ['body_a', 'body_b', 'body_c'];
const ROOF_NAMES = ['roof_flat', 'roof_pitched'];
/** Height of the kit annex at build = 1 (m): extras hide below MIN_H of it. */
const ANNEX_H = 1.44;
/** Salt separating the roof pick from the body pick of the same slug. */
const ROOF_SALT = '#roof';

export function createBuildings(layout: LotLayout, palette: CityPalette, kit?: Kit | null): CityPart {
  if (kit) return createKitBuildings(layout, palette, kit);
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
    mainW.push(lot.w * FOOTPRINT);
    mainD.push(lot.d * FOOTPRINT);
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
  const oldGeo = new BoxGeometry(1, 1, 1);
  oldGeo.translate(0, 0.5, 0);

  // White base so the per-instance palette lane colours show unmodified.
  const mainMat = new MeshLambertMaterial({ color: 0xffffff });
  const reworkMat = new MeshLambertMaterial({ color: 0xffffff });
  const extraMat = new MeshLambertMaterial({ color: 0xffffff });
  const oldMat = new MeshLambertMaterial({ color: 0xffffff });

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
  const nOld: number = layout.existing.length;
  const oldMesh = new InstancedMesh(oldGeo, oldMat, nOld > 0 ? nOld : 1);
  oldMesh.name = 'buildings-existing';
  oldMesh.count = nOld;
  oldMesh.frustumCulled = false;
  root.add(oldMesh);
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
  // The existing city never changes: matrices and colours are set once here.
  const oldBase = oldBaseColour(palette);
  {
    const p = new Vector3(), sc = new Vector3(), q = new Quaternion(), m = new Matrix4();
    for (let i = 0; i < nOld; i++) {
      const b = layout.existing[i];
      p.set(b.x, 0, b.z);
      sc.set(b.w, b.height, b.d);
      oldMesh.setMatrixAt(i, m.compose(p, q, sc));
      // Seeded from the index (Knuth hash), so the same layout always gets the same shades.
      const f = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      oldMesh.setColorAt(i, col.copy(oldBase).multiplyScalar(1 - OLD_SPREAD / 2 + OLD_SPREAD * f));
    }
  }
  const seeded: InstancedMesh[] = [oldMesh, mainMesh, reworkMesh, extraMesh];
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
      // A zero-height instance would turn its top face's normal into NaN (rendered black): collapse it instead.
      if (h > MIN_H) sclV.set(mainW[k], h, mainD[k]);
      else sclV.set(0, 0, 0);
      mat.compose(posV, quat, sclV);
      mainMesh.setMatrixAt(k, mat);
      const bandH = mainH[k] * REWORK_FRACTION * rework;
      posV.set(pose.x, pose.y + h, pose.z);
      if (bandH > MIN_H) sclV.set(mainW[k] * REWORK_OVERHANG, bandH, mainD[k] * REWORK_OVERHANG);
      else sclV.set(0, 0, 0);
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
      if (h > MIN_H) sclV.set(extraW[j], h, extraD[j]);
      else sclV.set(0, 0, 0);
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
    oldGeo.dispose();
    oldMat.dispose();
    mainMat.dispose();
    reworkMat.dispose();
    extraMat.dispose();
  }

  return { object: root, update, dispose };
}

// ---------------------------------------------------------------------------------------------------------------
// Kit path: the same lots and merge poses, dressed with the Blender modules. Every module is two InstancedMeshes
// sharing matrices: the neutral part with the shared kit material, and the `<name>_lane` part with a white-base
// clone tinted per instance. With no kit the placeholder path above keeps working unchanged.

function createKitBuildings(layout: LotLayout, palette: CityPalette, kit: Kit): CityPart {
  const mainIndex: number[] = [];
  const extraIndex: number[] = [];
  for (let i = 0; i < layout.lots.length; i++) {
    if (layout.lots[i].extra) extraIndex.push(i);
    else mainIndex.push(i);
  }
  const nMain: number = mainIndex.length;
  const nExtra: number = extraIndex.length;

  const agyHex: string = palette.laneAgy;
  const opencodeHex: string = palette.laneOpencode;
  const agyCol = new Color(agyHex);
  const opencodeCol = new Color(opencodeHex);
  const scafTint = new Color();
  const oldBase = oldBaseColour(palette);

  // White base so per-instance lane colours show unmodified (white map swatch times instanceColor). `laneMat` is the
  // plain one (existing city, scaffold); `laneGlowMat` is the new lots', self-lit in the lane colour.
  const laneMat = kit.material.clone();
  (laneMat as unknown as { color: Color }).color.set(0xffffff);
  const mask = glowMask();
  const warm = new Color(palette.lightWarm);
  const winNewMat = windowMaterial(kit.material, mask, warm, WIN_GLOW_NEW);
  const winOldMat = windowMaterial(kit.material, mask, warm, WIN_GLOW_OLD);
  const laneGlowMat = laneGlowMaterial(kit.material, LANE_GLOW_NEW);
  const glowAttrs: InstancedBufferAttribute[] = [];

  const root = new Group();
  root.name = 'buildings';
  const geometries: BufferGeometry[] = [];
  /** Per-mesh geometry clones carrying aGlow (the baked sources above stay shared). */
  const ownedGeos: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  // Lanes whose instanceColor changes per frame (the scaffold top rails).
  const dynamicLanes: InstancedMesh[] = [];

  /** Which materials a pair uses: plain, new-lot glow (windows + lane), or old-city windows. `win` / `lane` pick per part. */
  interface Glow { win?: Material; lane?: Material }
  interface Pair { base: InstancedMesh | null; lane: InstancedMesh | null; baseGlow: InstancedBufferAttribute | null; laneGlow: InstancedBufferAttribute | null }

  function pair(name: string, base: BufferGeometry | null, lane: BufferGeometry | null, count: number, glow: Glow = {}): Pair {
    let baseMesh: InstancedMesh | null = null;
    let laneMesh: InstancedMesh | null = null;
    let baseGlow: InstancedBufferAttribute | null = null;
    let laneGlow: InstancedBufferAttribute | null = null;
    if (base) {
      baseMesh = new InstancedMesh(base, glow.win ?? kit.material, count > 0 ? count : 1);
      baseMesh.name = name;
      baseMesh.count = count;
      baseMesh.frustumCulled = false;
      if (glow.win) {
        baseGlow = addGlow(baseMesh, count);
        glowAttrs.push(baseGlow);
        ownedGeos.push(baseMesh.geometry);
      }
      root.add(baseMesh);
      meshes.push(baseMesh);
    }
    if (lane) {
      laneMesh = new InstancedMesh(lane, glow.lane ?? laneMat, count > 0 ? count : 1);
      laneMesh.name = `${name}-lane`;
      laneMesh.count = count;
      laneMesh.frustumCulled = false;
      laneMesh.instanceMatrix.setUsage(DynamicDrawUsage);
      if (glow.lane) {
        laneGlow = addGlow(laneMesh, count);
        glowAttrs.push(laneGlow);
        ownedGeos.push(laneMesh.geometry);
      }
      root.add(laneMesh);
      meshes.push(laneMesh);
    }
    if (baseMesh) baseMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    return { base: baseMesh, lane: laneMesh, baseGlow, laneGlow };
  }

  // Per-lot dressing, fixed at creation: body variant + roof pick from the slug hash, setback scale.
  const mainS: number[] = [];
  const mainH: number[] = [];
  const mainV: number[] = [];
  const mainR: number[] = [];
  const mainSub: number[] = [];
  const mainRoofSub: number[] = [];
  const mainLaneIsAgy: boolean[] = [];
  const bodyCounts = [0, 0, 0];
  const roofCounts = [0, 0];
  for (let k = 0; k < nMain; k++) {
    const lot = layout.lots[mainIndex[k]];
    mainS.push((lot.w * FOOTPRINT) / BODY_AUTHOR);
    mainH.push(lot.height);
    const v = pickVariant(lot.slug, 3);
    const r = pickVariant(lot.slug + ROOF_SALT, 2);
    mainV.push(v);
    mainR.push(r);
    mainSub.push(bodyCounts[v]++);
    mainRoofSub.push(roofCounts[r]++);
    mainLaneIsAgy.push(lot.lane === 'agy');
  }
  const extraS: number[] = [];
  const extraLaneIsAgy: boolean[] = [];
  for (let j = 0; j < nExtra; j++) {
    const lot = layout.lots[extraIndex[j]];
    extraS.push(lot.w / ANNEX_AUTHOR);
    extraLaneIsAgy.push(lot.lane === 'agy');
  }

  // Bake each module once; several InstancedMeshes may share one baked geometry (disposed once).
  const bodyGeos = BODY_NAMES.map((n) => kitPartGeometries(kit, n));
  const roofGeos = ROOF_NAMES.map((n) => kitPartGeometries(kit, n));
  const scafGeos = kitPartGeometries(kit, 'scaffold');
  const anxGeos = kitPartGeometries(kit, 'annex');
  const boxGeos = kitPartGeometries(kit, 'roof_box');
  for (const g of [...bodyGeos, ...roofGeos, scafGeos, anxGeos, boxGeos]) {
    if (g.base && !geometries.includes(g.base)) geometries.push(g.base);
    if (g.lane && !geometries.includes(g.lane)) geometries.push(g.lane);
  }

  // Bodies (3 variants), roofs (flat / pitched), the rework scaffold, the annex extras.
  const bodyBase: (InstancedMesh | null)[] = [];
  const bodyLane: (InstancedMesh | null)[] = [];
  const bodyBaseGlow: (InstancedBufferAttribute | null)[] = [];
  const bodyLaneGlow: (InstancedBufferAttribute | null)[] = [];
  const roofLaneGlow: (InstancedBufferAttribute | null)[] = [];
  for (let v = 0; v < 3; v++) {
    const p = pair(`buildings-body-${BODY_NAMES[v]}`, bodyGeos[v].base, bodyGeos[v].lane, bodyCounts[v], { win: winNewMat, lane: laneGlowMat });
    bodyBase.push(p.base);
    bodyLane.push(p.lane);
    bodyBaseGlow.push(p.baseGlow);
    bodyLaneGlow.push(p.laneGlow);
  }
  const roofBase: (InstancedMesh | null)[] = [];
  const roofLane: (InstancedMesh | null)[] = [];
  for (let r = 0; r < 2; r++) {
    const p = pair(`buildings-${ROOF_NAMES[r]}`, roofGeos[r].base, roofGeos[r].lane, roofCounts[r], { lane: laneGlowMat });
    roofBase.push(p.base);
    roofLane.push(p.lane);
    roofLaneGlow.push(p.laneGlow);
  }
  const scaf = pair('buildings-scaffold', scafGeos.base, scafGeos.lane, nMain);
  if (scaf.lane) dynamicLanes.push(scaf.lane);
  if (scaf.base) dynamicLanes.push(scaf.base);
  const anx = pair('buildings-annex', anxGeos.base, anxGeos.lane, nExtra, { win: winNewMat, lane: laneGlowMat });

  // Static per-instance lane colours: bodies, roofs and annexes keep their lot's lane.
  const col = new Color();
  for (let k = 0; k < nMain; k++) {
    col.copy(mainLaneIsAgy[k] ? agyCol : opencodeCol);
    const bl = bodyLane[mainV[k]];
    if (bl) bl.setColorAt(mainSub[k], col);
    const rl = roofLane[mainR[k]];
    if (rl) rl.setColorAt(mainRoofSub[k], col);
    if (scaf.lane) scaf.lane.setColorAt(k, col);
    if (scaf.base) scaf.base.setColorAt(k, col);
  }
  for (let j = 0; j < nExtra; j++) {
    if (anx.lane) anx.lane.setColorAt(j, extraLaneIsAgy[j] ? agyCol : opencodeCol);
  }

  // The existing city: the same bodies (variant seeded from the index) with roof_flat or roof_box caps, always
  // visible, in a warm grey on the lane part (never a lane colour).
  const nOld: number = layout.existing.length;
  const oldV: number[] = [];
  const oldFlat: boolean[] = [];
  const oldBodyCounts = [0, 0, 0];
  let oldFlatCount = 0;
  let oldBoxCount = 0;
  for (let i = 0; i < nOld; i++) {
    const v = pickVariant(`existing:${i}`, 3);
    oldV.push(v);
    oldBodyCounts[v]++;
    const flat = pickVariant(`exroof:${i}`, 2) === 0;
    oldFlat.push(flat);
    if (flat) oldFlatCount++;
    else oldBoxCount++;
  }
  const oldBodyBase: (InstancedMesh | null)[] = [];
  const oldBodyLane: (InstancedMesh | null)[] = [];
  const oldBodyGlow: (InstancedBufferAttribute | null)[] = [];
  for (let v = 0; v < 3; v++) {
    const p = pair(`buildings-old-${BODY_NAMES[v]}`, bodyGeos[v].base, bodyGeos[v].lane, oldBodyCounts[v], { win: winOldMat });
    oldBodyBase.push(p.base);
    oldBodyLane.push(p.lane);
    oldBodyGlow.push(p.baseGlow);
  }
  // roof_flat is roofGeos[0]: the existing city shares the new lots' baked cap.
  const oldFlatP = pair('buildings-old-roof_flat', roofGeos[0].base, roofGeos[0].lane, oldFlatCount);
  const oldBoxP = pair('buildings-old-roof_box', boxGeos.base, null, oldBoxCount);
  {
    const p = new Vector3(), sc = new Vector3(), q = new Quaternion(), m = new Matrix4();
    const bodySubs = [0, 0, 0];
    let flatSub = 0;
    let boxSub = 0;
    for (let i = 0; i < nOld; i++) {
      const b = layout.existing[i];
      const sx = b.w / BODY_AUTHOR;
      const sz = b.d / BODY_AUTHOR;
      p.set(b.x, 0, b.z);
      sc.set(sx, b.height, sz);
      m.compose(p, q, sc);
      const bb = oldBodyBase[oldV[i]];
      if (bb) bb.setMatrixAt(bodySubs[oldV[i]], m);
      // Few windows lit, a seeded share per building.
      const og = oldBodyGlow[oldV[i]];
      if (og) og.setX(bodySubs[oldV[i]], OLD_LIT_MIN + (OLD_LIT_MAX - OLD_LIT_MIN) * ((Math.imul(i + 7, 40503) >>> 0) / 4294967296));
      // Warm grey with a seeded lightness spread (from the index, like the placeholder path).
      const f = (Math.imul(i + 1, 2654435761) >>> 0) / 4294967296;
      const bl = oldBodyLane[oldV[i]];
      if (bl) bl.setMatrixAt(bodySubs[oldV[i]], m);
      if (bl) bl.setColorAt(bodySubs[oldV[i]], col.copy(oldBase).multiplyScalar(1 - OLD_SPREAD / 2 + OLD_SPREAD * f));
      bodySubs[oldV[i]]++;
      // Caps sit on the deck unscaled in Y; the rooftop box keeps its authored offset near the roof centre.
      p.set(b.x, b.height, b.z);
      sc.set(sx, 1, sz);
      if (oldFlat[i]) {
        if (oldFlatP.base) oldFlatP.base.setMatrixAt(flatSub, m.compose(p, q, sc));
        if (oldFlatP.lane) {
          oldFlatP.lane.setMatrixAt(flatSub, m);
          oldFlatP.lane.setColorAt(flatSub, col.copy(oldBase).multiplyScalar(1 - OLD_SPREAD / 2 + OLD_SPREAD * f));
        }
        flatSub++;
      } else {
        p.set(b.x, b.height + 0.08, b.z);
        if (oldBoxP.base) oldBoxP.base.setMatrixAt(boxSub, m.compose(p, q, sc));
        boxSub++;
      }
    }
  }
  for (const mesh of meshes) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  for (const a of glowAttrs) a.needsUpdate = true;

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
      lotPoseAt(layout, mainIndex[k], merge, pose);
      const s = mainS[k];
      const h = mainH[k] * build;
      const bb = bodyBase[mainV[k]];
      const bl = bodyLane[mainV[k]];
      const rb = roofBase[mainR[k]];
      const rl = roofLane[mainR[k]];
      posV.set(pose.x, pose.y, pose.z);
      if (h > MIN_H) sclV.set(s, h, s);
      else sclV.set(0, 0, 0);
      mat.compose(posV, quat, sclV);
      if (bb) bb.setMatrixAt(mainSub[k], mat);
      if (bl) bl.setMatrixAt(mainSub[k], mat);
      // Lights come on as the lot is built: the share of lit windows and the lane glow follow its build.
      const lit = litAt(build);
      const gb = bodyBaseGlow[mainV[k]];
      const gl = bodyLaneGlow[mainV[k]];
      const gr = roofLaneGlow[mainR[k]];
      if (gb) gb.setX(mainSub[k], lit);
      if (gl) gl.setX(mainSub[k], lit);
      if (gr) gr.setX(mainRoofSub[k], lit);
      // The roof cap rides the body top unscaled in Y; hidden with the body.
      posV.set(pose.x, pose.y + h, pose.z);
      if (h > MIN_H) sclV.set(s, 1, s);
      else sclV.set(0, 0, 0);
      mat.compose(posV, quat, sclV);
      if (rb) rb.setMatrixAt(mainRoofSub[k], mat);
      if (rl) rl.setMatrixAt(mainRoofSub[k], mat);
      // The rework scaffold: the kit's full cage around the body while a rework pass runs (reworkLane set), scale
      // (s, h, s) like the body, its top rail in the rework lane's colour. Any other time it is hidden (zero scale).
      posV.set(pose.x, pose.y, pose.z);
      if (worker.reworkLane !== null && h > MIN_H) sclV.set(s, h, s);
      else sclV.set(0, 0, 0);
      mat.compose(posV, quat, sclV);
      if (scaf.base) scaf.base.setMatrixAt(k, mat);
      if (scaf.lane) {
        scaf.lane.setMatrixAt(k, mat);
        const lane = worker.reworkLane !== null ? worker.reworkLane : worker.lane;
        scaf.lane.setColorAt(k, lane === 'agy' ? agyCol : opencodeCol);
        // The poles and braces take a warm steel tint pulled towards the lane colour, so the thin cage reads bold.
        if (scaf.base) scaf.base.setColorAt(k, scafTint.copy(SCAF_STEEL).lerp(lane === 'agy' ? agyCol : opencodeCol, SCAF_LANE_MIX));
      }
    }
    for (let j = 0; j < nExtra; j++) {
      const extra = state.extras[j];
      const build = extra.build <= 0 ? 0 : extra.build >= 1 ? 1 : extra.build;
      const merge = extra.merge <= 0 ? 0 : extra.merge >= 1 ? 1 : extra.merge;
      lotPoseAt(layout, extraIndex[j], merge, pose);
      posV.set(pose.x, pose.y, pose.z);
      if (build * ANNEX_H > MIN_H) sclV.set(extraS[j], build, extraS[j]);
      else sclV.set(0, 0, 0);
      mat.compose(posV, quat, sclV);
      if (anx.base) anx.base.setMatrixAt(j, mat);
      if (anx.lane) anx.lane.setMatrixAt(j, mat);
      const lit = litAt(build);
      if (anx.baseGlow) anx.baseGlow.setX(j, lit);
      if (anx.laneGlow) anx.laneGlow.setX(j, lit);
    }
    for (let gi = 0; gi < glowAttrs.length; gi++) glowAttrs[gi].needsUpdate = true;
    for (let mi = 0; mi < meshes.length; mi++) meshes[mi].instanceMatrix.needsUpdate = true;
    for (let li = 0; li < dynamicLanes.length; li++) {
      const ic = dynamicLanes[li].instanceColor;
      if (ic !== null) ic.needsUpdate = true;
    }
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.clear();
    for (const g of geometries) g.dispose();
    for (const g of ownedGeos) g.dispose();
    laneMat.dispose();
    laneGlowMat.dispose();
    winNewMat.dispose();
    winOldMat.dispose();
    mask.dispose();
  }

  return { object: root, update, dispose };
}
