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
import { BoxGeometry, Color, ConeGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import type { CityPalette, CityPart, CreateDrones, LotLayout, StageState } from './types.ts';

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

export const createDrones: CreateDrones = (layout: LotLayout, palette: CityPalette): CityPart => {
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
