// SwarmKit City kit: the approved Blender modules in site/public/models/*.glb.
//
// loadKit fetches buildings/drone/depot/props in parallel (table.glb is not used yet), keeps one shared palette
// material for every neutral mesh, and records the template nodes by name. Parts clone() whole nodes (drones,
// depots) or bake named meshes into instanced geometry via kitPartGeometries; they must never dispose the shared
// templates (see Kit.dispose, owned by the scene).
import {
  BufferGeometry,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  SRGBColorSpace,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The loaded kit: one shared palette material plus template nodes by node name. Parts clone from these. */
export interface Kit {
  /** The shared kit material (palette texture, nearest filtering, no mipmaps, sRGB). Owned by the kit. */
  material: Material;
  /** Every named node in the kit files (modules and their `<name>_lane` children), by node name. */
  templates: Map<string, Object3D>;
  /** Free the kit's own geometries, material and texture. Call after all parts are disposed. */
  dispose(): void;
}

const KIT_FILES = ['buildings.glb', 'drone.glb', 'depot.glb', 'props.glb'];

/** Load the kit files in parallel and unify them onto one shared material. Never throws for missing nodes. */
export async function loadKit(base = '/models/'): Promise<Kit> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltfs = await Promise.all(KIT_FILES.map((f) => loader.loadAsync(base + f)));

  // The shared material: the first mesh material in buildings.glb (body_a's kit_palette).
  let shared: Material | null = null;
  for (const g of gltfs) {
    g.scene.traverse((o) => {
      if (shared !== null) return;
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (m) shared = m as Material;
      }
    });
    if (shared !== null) break;
  }
  if (shared === null) throw new Error('loadKit: no mesh material in kit');
  const kitMat = shared as MeshStandardMaterial;

  // One palette texture for every module: nearest filtering, no mipmaps, sRGB.
  if (kitMat.map) {
    kitMat.map.magFilter = NearestFilter;
    kitMat.map.minFilter = NearestFilter;
    kitMat.map.generateMipmaps = false;
    kitMat.map.colorSpace = SRGBColorSpace;
    kitMat.map.needsUpdate = true;
  }

  // Every mesh shares the one material; the files' duplicate palette copies are freed (load-time only).
  const replaced = new Set<Material>();
  for (const g of gltfs) {
    g.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.material !== kitMat) {
        const old = mesh.material;
        mesh.material = kitMat;
        const list = Array.isArray(old) ? old : [old];
        for (const m of list) if (m && m !== kitMat) replaced.add(m as Material);
      }
    });
  }
  for (const m of replaced) {
    const mm = m as MeshStandardMaterial;
    if (mm.map && mm.map !== kitMat.map) mm.map.dispose();
    m.dispose();
  }

  const templates = new Map<string, Object3D>();
  for (const g of gltfs) {
    g.scene.traverse((o) => {
      if (o.name && !templates.has(o.name)) templates.set(o.name, o);
    });
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    const geos = new Set<BufferGeometry>();
    for (const g of gltfs) {
      g.scene.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh) {
          const geo = mesh.geometry as BufferGeometry;
          if (geo && !geos.has(geo)) {
            geos.add(geo);
            geo.dispose();
          }
        }
      });
    }
    if (kitMat.map) kitMat.map.dispose();
    kitMat.dispose();
  }

  return { material: kitMat, templates, dispose };
}

/** Baked geometry of one kit module: the neutral meshes and the `<name>_lane` meshes, split for tinting. */
export interface KitPartGeos {
  base: BufferGeometry | null;
  lane: BufferGeometry | null;
}

// Scratch matrices for load-time baking only (never touched per frame).
const bakeInv = new Matrix4();
const bakeRel = new Matrix4();

/**
 * Return clones of the named module's geometry with the authored local transforms baked in, so an InstancedMesh
 * can carry them: `base` merges every mesh under `name` except the lane subtree, `lane` merges the meshes under
 * `<name>_lane` (null when the module has no lane part). The caller owns the returned geometries.
 */
export function kitPartGeometries(kit: Kit, name: string): KitPartGeos {
  const root = kit.templates.get(name);
  if (!root) return { base: null, lane: null };
  const laneRoot: Object3D | null = root.getObjectByName(`${name}_lane`);
  let top: Object3D = root;
  while (top.parent) top = top.parent;
  top.updateMatrixWorld(true);
  bakeInv.copy(root.matrixWorld).invert();
  const baseGeos: BufferGeometry[] = [];
  const laneGeos: BufferGeometry[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.geometry as BufferGeometry;
    if (!src) return;
    let isLane = false;
    if (laneRoot) {
      let p: Object3D | null = mesh;
      while (p) {
        if (p === laneRoot) {
          isLane = true;
          break;
        }
        p = p.parent;
      }
    }
    const g = src.clone();
    bakeRel.multiplyMatrices(bakeInv, mesh.matrixWorld);
    g.applyMatrix4(bakeRel);
    (isLane ? laneGeos : baseGeos).push(g);
  });
  return { base: mergeBaked(baseGeos), lane: mergeBaked(laneGeos) };
}

function mergeBaked(list: BufferGeometry[]): BufferGeometry | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const merged = mergeGeometries(list, false);
  if (!merged) return list[0];
  for (const g of list) g.dispose();
  return merged;
}
