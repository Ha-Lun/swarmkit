// Lane drones: one depot marker box plus three small cones per lane in layout.depots.
//
// Behaviour (all pure in the scroll state; `dt` only advances the hover bob):
// - depot marker: lane colour (laneAgy / laneOpencode) when depot.used, a low dark
//   ink slab when unused (flat vs tall: unused differs in SHAPE, never colour alone).
// - drone d of lane k serves state.drones[k].jobs[d]; with no job it is parked at the
//   depot (exact spot, no bob). For a job it flies depot -> over the lot during the
//   first 15% of job.progress, hovers at lot.height + HOVER_GAP with a sine bob, and
//   glides home over the last 15% (progress >= 1 is parked again).
//
// Children order (tests rely on it): per lane k, depot mesh then its 3 drone cones,
// i.e. children[k * (1 + DRONES_PER_DEPOT) + 1 + d] is drone d of lane k.
import { BoxGeometry, Color, ConeGeometry, Group, Material, Mesh, MeshLambertMaterial, Object3D } from 'three';
import type { CityPalette, CityPart, CreateDrones, LotLayout, StageState } from './types.ts';
import type { Kit } from './kit.ts';

/** Cones per depot. */
export const DRONES_PER_DEPOT = 3;
/** Job progress at which the outbound flight ends (depot -> lot). */
const OUT_END = 0.15;
/** Job progress at which the home flight starts (lot -> depot). */
const HOME_START = 0.85;
/** Hover height above the lot's finished building height (m). */
const HOVER_GAP = 1.4;
/** Parking ring radius around the depot centre (m). */
const PARK_RADIUS = 1.1;
/** Cone size (m): radius 0.22, height 0.55. */
const CONE_HALF = 0.275;
/** Hover bob amplitude (m) and angular frequency (rad/s). */
const BOB_AMP = 0.18;
const BOB_FREQ = 3.0;

function clamp01(x: number): number {
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

function smooth(x: number): number {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}

export const createDrones: CreateDrones = (layout: LotLayout, palette: CityPalette, kit?: Kit | null): CityPart => {
  if (kit) return createKitDrones(layout, palette, kit);
  const root = new Group();
  const laneCount = layout.depots.length;

  const lotBySlug = new Map<string, number>();
  for (let i = 0; i < layout.lots.length; i++) lotBySlug.set(layout.lots[i].slug, i);

  const coneGeo = new ConeGeometry(0.22, 0.55, 6);
  const boxUsedGeo = new BoxGeometry(1.5, 0.7, 1.5);
  const boxFlatGeo = new BoxGeometry(1.5, 0.22, 1.5);
  const materials: MeshLambertMaterial[] = [];

  const depotX: number[] = [];
  const depotZ: number[] = [];
  const depotFacing: number[] = [];
  const parkX: number[] = [];
  const parkZ: number[] = [];
  const drones: Mesh[] = [];

  for (let k = 0; k < laneCount; k++) {
    const depot = layout.depots[k];
    depotX.push(depot.x);
    depotZ.push(depot.z);
    depotFacing.push(depot.facing);
    const used = depot.used;
    const laneColour = depot.lane === 'agy' ? palette.laneAgy : palette.laneOpencode;

    const depotMat = new MeshLambertMaterial({
      color: used ? new Color(laneColour) : new Color(palette.ink).multiplyScalar(0.45),
    });
    materials.push(depotMat);
    const depotMesh = new Mesh(used ? boxUsedGeo : boxFlatGeo, depotMat);
    depotMesh.position.set(depot.x, used ? 0.35 : 0.11, depot.z);
    depotMesh.rotation.y = depot.facing;
    root.add(depotMesh);

    const droneMat = new MeshLambertMaterial({
      color: used ? new Color(laneColour) : new Color(palette.ink).multiplyScalar(0.6),
    });
    materials.push(droneMat);
    for (let d = 0; d < DRONES_PER_DEPOT; d++) {
      const a = depot.facing + (d * Math.PI * 2) / DRONES_PER_DEPOT;
      const px = depot.x + Math.cos(a) * PARK_RADIUS;
      const pz = depot.z + Math.sin(a) * PARK_RADIUS;
      parkX.push(px);
      parkZ.push(pz);
      const m = new Mesh(coneGeo, droneMat);
      m.position.set(px, CONE_HALF, pz);
      m.rotation.set(0, depot.facing, 0);
      root.add(m);
      drones.push(m);
    }
  }

  // Idle-motion clock only; the base position below is a pure function of `state`.
  let time = 0;

  function update(state: StageState, dt: number): void {
    time += dt;
    for (let k = 0; k < laneCount; k++) {
      const nJobs = k < state.drones.length ? state.drones[k].jobs.length : 0;
      for (let d = 0; d < DRONES_PER_DEPOT; d++) {
        const di = k * DRONES_PER_DEPOT + d;
        const m = drones[di];
        if (d < nJobs) {
          const job = state.drones[k].jobs[d];
          const li = lotBySlug.get(job.slug);
          if (li === undefined) {
            m.position.set(parkX[di], CONE_HALF, parkZ[di]);
            m.rotation.set(0, depotFacing[k], 0);
          } else {
            const lot = layout.lots[li];
            const p = clamp01(job.progress);
            let s: number;
            if (p <= 0) s = 0;
            else if (p < OUT_END) s = smooth(p / OUT_END);
            else if (p <= HOME_START) s = 1;
            else if (p >= 1) s = 0;
            else s = 1 - smooth((p - HOME_START) / (1 - HOME_START));
            const hoverY = lot.height + HOVER_GAP;
            const x = depotX[k] + (lot.x - depotX[k]) * s;
            const z = depotZ[k] + (lot.z - depotZ[k]) * s;
            const bob = Math.sin(time * BOB_FREQ + di * 1.7) * BOB_AMP * s;
            m.position.set(x, CONE_HALF + (hoverY - CONE_HALF) * s + bob, z);
            m.rotation.set(0, Math.atan2(lot.x - depotX[k], lot.z - depotZ[k]), 0);
          }
        } else {
          m.position.set(parkX[di], CONE_HALF, parkZ[di]);
          m.rotation.set(0, depotFacing[k], 0);
        }
      }
    }
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    coneGeo.dispose();
    boxUsedGeo.dispose();
    boxFlatGeo.dispose();
    for (let i = 0; i < materials.length; i++) materials[i].dispose();
  }

  return { object: root, update, dispose };
};

// ---------------------------------------------------------------------------------------------------------------
// Kit path: cloned drone cranes and depot hangars from the Blender kit. Flight logic matches the placeholder path
// (depot -> lot over the first 15% of progress, hover, home over the last 15%); the kit adds rotor spin, a hook
// that pays out while hovering, and per-lane tinted canopies. With no kit the placeholder path above is unchanged.

/** Whole-drone scale (authored span 0.62 m reads too small next to 3.6 m lots). */
const DRONE_SCALE = 1.5;
/** Rotor angular speed (rad/s): idle motion only, driven by dt. */
const ROTOR_SPEED = 18;
/** Hook winch pivot and cable length (m, from public/models/README.md). */
const HOOK_PIVOT_Y = 0.13;
const HOOK_LEN = 0.085;
/** Parked hook: nearly fully retracted. */
const HOOK_PARK_K = 0.05;
const HOOK_PARK_HEAD_Y = 0.126;
/** Hook extension while fully hovering: the head touches the building top (hover gap paid out). */
const HOOK_K_HOVER = (HOOK_PIVOT_Y + HOVER_GAP / DRONE_SCALE) / HOOK_LEN;
/** Parked drones sit on the pad, in depot space (y is the pad top). */
const PAD_RING_Y = 0.06;
/**
 * Parked drones stand across the pad, in depot space. The pad is 3.4 m wide and 1.4 m deep (z 0.4..1.8) and a drone
 * is 1.35 m across the rotors (1.5x) and 0.93 m across the body, so three cannot sit in a row: the outer two stand
 * PAD_PITCH either side of the centre line and the middle one steps PAD_STAGGER toward the open end, which tucks
 * its rotors between theirs (hub-to-hub distance 0.477 m for 0.45 m rotor discs, so they never touch). All three
 * bodies stand on the pad (the outer ones flush with its side edges, the middle one with its front edge); only the
 * outer rotor tips reach 0.21 m past the pad's sides and the outer rear rotors 0.075 m toward the hangar door.
 */
const PAD_PITCH = 1.235;
const PAD_STAGGER = 0.335;
/** The outer drones' z in depot space. */
const PAD_ROW_Z = 1.0;
/**
 * Rotor blades hide below this screen scale (px per metre at the look-at point): a 1.35 m rotor span is then under
 * ~30 px, where the thin dark crossed blades only read as black crosses. Measured: phone hero ~12 px/m, desktop task
 * beat ~30 px/m. A pure function of viewport and camera, so the same state gives the same picture.
 */
const ROTOR_MIN_PX_PER_M = 26;
/** Rotor blades are a light steel grey instead of the kit's near-black ink, so tiny blades fade into the table instead of speckling it. */
const ROTOR_GREY = '#aab2ba';
const ROTOR_NAMES = ['rotor_fl', 'rotor_fr', 'rotor_bl', 'rotor_br'];

/** A per-lane copy of the shared kit material, tinted to one colour. */
function tintedClone(base: Material, hex: string): Material {
  const m = base.clone();
  (m as unknown as { color: Color }).color.set(hex);
  return m;
}

function createKitDrones(layout: LotLayout, palette: CityPalette, kit: Kit): CityPart {
  const root = new Group();
  root.name = 'drones';
  const laneCount = layout.depots.length;

  const lotBySlug = new Map<string, number>();
  for (let i = 0; i < layout.lots.length; i++) lotBySlug.set(layout.lots[i].slug, i);

  // One lane material per colour (white map swatch times colour), plus a dim one for the unused lane.
  const laneMatAgy = tintedClone(kit.material, palette.laneAgy);
  const laneMatOpencode = tintedClone(kit.material, palette.laneOpencode);
  const laneMatDim = tintedClone(kit.material, palette.ink);
  (laneMatDim as unknown as { color: Color }).color.multiplyScalar(0.6);
  const laneMats = [laneMatAgy, laneMatOpencode];

  // Rotor material: the kit material without its palette map, flat light grey (see ROTOR_GREY).
  const rotorMat = kit.material.clone();
  (rotorMat as unknown as { map: unknown }).map = null;
  (rotorMat as unknown as { color: Color }).color.set(ROTOR_GREY);
  rotorMat.needsUpdate = true;

  const droneTpl = kit.templates.get('drone');
  const depotTpl = kit.templates.get('depot');

  const depotX: number[] = [];
  const depotZ: number[] = [];
  const depotFacing: number[] = [];
  const parkX: number[] = [];
  const parkZ: number[] = [];
  const drones: Object3D[] = [];
  const rotors: Object3D[] = [];
  const cables: Object3D[] = [];
  const heads: Object3D[] = [];
  // Never in the scene: a stand-in when a named kit node is missing, so a missing rotor never spins a drone.
  const dummy = new Object3D();

  function dress(clone: Object3D, laneMat: Material): void {
    clone.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      let p: Object3D | null = mesh;
      let isLane = false;
      while (p && p !== clone) {
        if (p.name.endsWith('_lane')) {
          isLane = true;
          break;
        }
        p = p.parent;
      }
      let isRotor = false;
      for (let q: Object3D | null = mesh; q && q !== clone; q = q.parent) if (q.name.startsWith('rotor_')) isRotor = true;
      mesh.material = isLane ? laneMat : isRotor ? rotorMat : kit.material;
    });
  }

  for (let k = 0; k < laneCount; k++) {
    const depot = layout.depots[k];
    depotX.push(depot.x);
    depotZ.push(depot.z);
    depotFacing.push(depot.facing);
    const laneMat = depot.lane === 'agy' ? laneMatAgy : laneMatOpencode;

    if (depotTpl) {
      const hall = depotTpl.clone(true);
      dress(hall, depot.used ? laneMat : laneMatDim);
      hall.position.set(depot.x, 0, depot.z);
      hall.rotation.y = depot.facing;
      root.add(hall);
    } else {
      const fallback = new Group();
      fallback.position.set(depot.x, 0, depot.z);
      fallback.rotation.y = depot.facing;
      root.add(fallback);
    }

    for (let d = 0; d < DRONES_PER_DEPOT; d++) {
      // Parking slots in a row across the pad, in depot space, so they follow the depot yaw.
      const lx = (d - (DRONES_PER_DEPOT - 1) / 2) * PAD_PITCH;
      const lz = PAD_ROW_Z + (d % 2 === 1 ? PAD_STAGGER : 0);
      const cf = Math.cos(depot.facing);
      const sf = Math.sin(depot.facing);
      const px = depot.x + lx * cf + lz * sf;
      const pz = depot.z - lx * sf + lz * cf;
      parkX.push(px);
      parkZ.push(pz);
      const drone = droneTpl ? droneTpl.clone(true) : new Group();
      dress(drone, depot.used ? laneMat : laneMatDim);
      drone.scale.setScalar(DRONE_SCALE);
      drone.position.set(px, PAD_RING_Y, pz);
      drone.rotation.set(0, depot.facing, 0);
      root.add(drone);
      drones.push(drone);
      for (let ri = 0; ri < ROTOR_NAMES.length; ri++) rotors.push(drone.getObjectByName(ROTOR_NAMES[ri]) ?? dummy);
      cables.push(drone.getObjectByName('hook_cable') ?? dummy);
      heads.push(drone.getObjectByName('hook_head') ?? dummy);
      // Parked: hook nearly fully retracted.
      cables[cables.length - 1].scale.y = HOOK_PARK_K;
      heads[heads.length - 1].position.y = HOOK_PARK_HEAD_Y;
    }
  }

  // Idle-motion clock only; base positions are a pure function of `state`.
  let time = 0;

  function update(state: StageState, dt: number): void {
    time += dt;
    for (let ri = 0; ri < rotors.length; ri++) rotors[ri].rotation.y += dt * ROTOR_SPEED;
    for (let k = 0; k < laneCount; k++) {
      const nJobs = k < state.drones.length ? state.drones[k].jobs.length : 0;
      for (let d = 0; d < DRONES_PER_DEPOT; d++) {
        const di = k * DRONES_PER_DEPOT + d;
        const m = drones[di];
        const cable = cables[di];
        const head = heads[di];
        if (d < nJobs) {
          const job = state.drones[k].jobs[d];
          const li = lotBySlug.get(job.slug);
          if (li === undefined) {
            m.position.set(parkX[di], PAD_RING_Y, parkZ[di]);
            m.rotation.set(0, depotFacing[k], 0);
            cable.scale.y = HOOK_PARK_K;
            head.position.y = HOOK_PARK_HEAD_Y;
          } else {
            const lot = layout.lots[li];
            const p = clamp01(job.progress);
            let s: number;
            if (p <= 0) s = 0;
            else if (p < OUT_END) s = smooth(p / OUT_END);
            else if (p <= HOME_START) s = 1;
            else if (p >= 1) s = 0;
            else s = 1 - smooth((p - HOME_START) / (1 - HOME_START));
            const hoverY = lot.height + HOVER_GAP;
            const x = depotX[k] + (lot.x - depotX[k]) * s;
            const z = depotZ[k] + (lot.z - depotZ[k]) * s;
            const bob = Math.sin(time * BOB_FREQ + di * 1.7) * BOB_AMP * s;
            m.position.set(x, PAD_RING_Y + (hoverY - PAD_RING_Y) * s + bob, z);
            m.rotation.set(0, Math.atan2(lot.x - depotX[k], lot.z - depotZ[k]), 0);
            // Pay the hook out while hovering so the head drops towards the roof; retracted in transit.
            const hk = HOOK_PARK_K + (HOOK_K_HOVER - HOOK_PARK_K) * s;
            cable.scale.y = hk;
            head.position.y = HOOK_PIVOT_Y - HOOK_LEN * hk;
          }
        } else {
          m.position.set(parkX[di], PAD_RING_Y, parkZ[di]);
          m.rotation.set(0, depotFacing[k], 0);
          cable.scale.y = HOOK_PARK_K;
          head.position.y = HOOK_PARK_HEAD_Y;
        }
      }
    }
  }

  let rotorsOn = true;
  function setDetail(pxPerMetre: number): void {
    const on = pxPerMetre >= ROTOR_MIN_PX_PER_M;
    if (on === rotorsOn) return;
    rotorsOn = on;
    for (let ri = 0; ri < rotors.length; ri++) rotors[ri].visible = on;
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.clear();
    for (const m of laneMats) m.dispose();
    laneMatDim.dispose();
    rotorMat.dispose();
  }

  return { object: root, update, setDetail, dispose };
}
