import {
  BufferGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, MeshBasicMaterial, MeshNormalMaterial, MeshPhysicalMaterial, Quaternion, SphereGeometry, Vector3, type WebGLRenderer,
} from 'three';
import { CELL_RADIUS, look, readPalette, SINK, type Look, type Tier } from './config';
import { motion, walkCfg } from './motion-config';
import { createCellMaterial, createStudioEnv, type CellUniforms } from './cell-material';
import { createCellDepthMaterial } from './cell-depth';
import { createCellNormalMaterial } from './cell-normal';
import { buildSphere, type Sphere } from './sphere';
import { terrainField } from './terrain';
import type { Agent } from '../agents';
import type { Band } from '../../content/tiers';

// The lattice is two Goldberg spheres (sphere.ts): the globe GP(5,0) and a small moon GP(2,0), both built the same way.
// Every cell is a flush stone panel: its footprint is the cell's own spherical-Voronoi polygon inset by half the seam, so
// the seam has one constant width over the whole surface, and every panel stands the same small relief above its sphere.
// Cell circumradius is ~1 world unit on the globe.
const SQRT3 = Math.sqrt(3);
export const GLOBE_FREQ = 5; // GP(5,0): 252 cells, 240 hex + 12 pentagons
export const MOON_FREQ = 2; // GP(2,0): 42 cells, 30 hex + 12 pentagons
const RELIEF = 0.05; // layout default of the panel relief (look.cell.relief scales the meshes live)
const MOON_CELL = 0.7; // moon cell size relative to a globe cell
const MOON_OFFSET = 1.85; // moon centre distance in globe radii
const MOON_DIR = new Vector3(0.86, 0.3, 0.4).normalize();
const HIVE_EYE = new Vector3(0, 0.37, 0.93).multiplyScalar(4.2); // the hive camera, in globe radii: the moon turns its core cell towards it
const SEAM_DEFAULT = 0.085;

// Agent panels are towers with a polished pale cap, standing fixed above every rod. Bands read apart by height (a tier step each: core tallest,
// then t1, domain, gate) and by a small tone step (a fraction of the stone tone, brightest at the core): no colour, no inlay, no ring.
const TOWER_RANK: Record<Band, number> = { core: 3, t1: 2, domain: 1, gate: 0, satellite: 0 };
const BAND_STEP: Record<Band, number> = { core: 0.1, t1: 0.075, domain: 0.05, gate: 0.025, satellite: 0 };

export interface Cell {
  /** base surface point of the panel (on its sphere) */
  pos: Vector3;
  /** outward unit normal: the panel extrudes along it */
  normal: Vector3;
  /** geodesic ring index from the core cell (graph distance); moon cells use maxRing so they appear last */
  ring: number;
  agent?: Agent;
  /** panel height above the sphere (world units) right now: `base` plus the piston stroke. update() writes it every frame;
   *  cellTopOf, the comet, the label cards and picking all read it. */
  height: number;
  /** resting height: relief plus the quantised terrain elevation, set by applyTerrain (the piston's low hold) */
  base: number;
  /** the most `height` can ever reach (base plus the full stroke, or a tower's base plus its breath): what a comet route must clear */
  reach: number;
  /** indices (into Lattice.cells) of the cells that share an edge with this one */
  neighbours: number[];
  /** 0..1 terrain value of this cell (its share of the elevation), for tinting */
  terrain: number;
  /** 0..1 stagger inside a ring so growth sweeps around */
  sweep: number;
  sides: 5 | 6;
  /** local xz corners (world units, seam 0) of the cell's Voronoi polygon, in the local frame of `quat`, ascending atan2(x, z) */
  poly: number[];
  /** how far each polygon edge's true (great-circle) position bulges past the straight chord between its corners, world units.
   *  It matters on the small moon (its cells are big against its radius): the inset subtracts it so the seam stays even there. */
  sag: number[];
  /** distance from the cell centre to its nearest edge (seam 0) */
  half: number;
  /** panel footprint size with the default seam: circumradius = CELL_RADIUS * scale */
  scale: number;
  /** radius of the sphere the panel sits on and its seam width */
  bodyRadius: number;
  seam: number;
  /** orients the footprint: local +Y = normal, local +Z = towards polygon corner 0 */
  quat: Quaternion;
  moon: boolean;
  /** unit-sphere polygon corners for outlines (in the body's own frame, never the moon's centre offset) */
  corners?: Vector3[];
  /** moon cells only: the parked layout pose. `pos`, `normal` and `quat` of a moon cell are LIVE (spin and drift, see setMoonPose); this is where it rests at home. */
  home?: { pos: Vector3; normal: Vector3; quat: Quaternion };
}

export interface Lattice {
  cells: Cell[];
  agentCount: number;
  /** last growth ring: moon cells sit on it, the globe's front hemisphere ends one before */
  maxRing: number;
  /** globe radius in world units */
  radius: number;
  /** mean hexagon circumradius (world units), for screen-space sizing */
  cellRadius: number;
  /** `centre` is the moon's HOME (layout) centre; `pos` its live centre (home plus drift) and `angle` its live spin about MOON_AXIS, both written by setMoonPose;
   *  `driftMax` is the farthest the centre may drift from home, world units (applyTerrain keeps it current) */
  moon: { centre: Vector3; normal: Vector3; radius: number; cells: number; pos: Vector3; angle: number; driftMax: number };
  /** pentagons on the globe (the moon has its own 12) */
  pentagons: number;
}

/** World-space top of a cell (panel top centre), in the pose of this frame (a moon cell is live: it spins and drifts). */
export const cellTopOf = (c: Cell, out = new Vector3()): Vector3 => out.copy(c.normal).multiplyScalar(c.height).add(c.pos);

const basisQuat = (y: Vector3, z: Vector3) => {
  const x = new Vector3().crossVectors(y, z).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)));
};

/** Local axes of a cell: x, y (normal), z (towards corner 0). */
export function cellFrame(c: Cell): { x: Vector3; y: Vector3; z: Vector3 } {
  return { x: new Vector3(1, 0, 0).applyQuaternion(c.quat), y: new Vector3(0, 1, 0).applyQuaternion(c.quat), z: new Vector3(0, 0, 1).applyQuaternion(c.quat) };
}

/** Inset a convex polygon (flat [x0, z0, x1, z1, ...] around the origin) by `d` on every edge; mitred corners. */
export function insetPolygon(poly: number[], d: number, out: number[] = [], sag?: number[]): number[] {
  const n = poly.length / 2;
  const nx: number[] = [], nz: number[] = [];
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const ex = poly[k1 * 2] - poly[k * 2], ez = poly[k1 * 2 + 1] - poly[k * 2 + 1];
    const l = Math.hypot(ex, ez) || 1;
    let ax = -ez / l, az = ex / l; // an edge normal; flip it to point at the cell centre
    if (ax * (poly[k * 2] + poly[k1 * 2]) + az * (poly[k * 2 + 1] + poly[k1 * 2 + 1]) > 0) { ax = -ax; az = -az; }
    nx.push(ax); nz.push(az);
  }
  for (let k = 0; k < n; k++) {
    const p = (k + n - 1) % n; // the edge before corner k is edge k-1, the edge after it is edge k
    // per-edge inset d - sag: mitre point of the two offset lines (offsets dp, dk along their inward normals)
    const dp = d - (sag ? sag[p] : 0), dk = d - (sag ? sag[k] : 0);
    const c = nx[p] * nx[k] + nz[p] * nz[k], det = 1 - c * c;
    if (det < 1e-9) { out[k * 2] = poly[k * 2] + nx[k] * dk; out[k * 2 + 1] = poly[k * 2 + 1] + nz[k] * dk; continue; }
    const a = (dp - c * dk) / det, b = (dk - c * dp) / det;
    out[k * 2] = poly[k * 2] + nx[p] * a + nx[k] * b;
    out[k * 2 + 1] = poly[k * 2 + 1] + nz[p] * a + nz[k] * b;
  }
  out.length = n * 2;
  return out;
}

/** The panel footprint of a cell for a given seam width (flat [x, z, ...] in the cell's local frame). */
export const footprint = (c: Cell, seam: number) => insetPolygon(c.poly, seam / 2, [], c.sag);

/** Voronoi polygon of a sphere cell in a local frame (world units, sphere radius R). Corners come out ascending atan2(x, z). */
function polygonOf(corners: Vector3[], normal: Vector3, R: number) {
  const toCorner = corners[0].clone().addScaledVector(normal, -corners[0].dot(normal)).normalize();
  const quat = basisQuat(normal, toCorner);
  const x = new Vector3(1, 0, 0).applyQuaternion(quat), z = new Vector3(0, 0, 1).applyQuaternion(quat);
  const pts = corners.map((c) => [R * c.dot(x), R * c.dot(z)] as const).sort((a, b) => Math.atan2(a[0], a[1]) - Math.atan2(b[0], b[1]));
  const poly = pts.flatMap(([px, pz]) => [px, pz]);
  // sorted corner order: recover the 3D corner for each sorted point to find the great-circle midpoint of every edge
  const sorted = corners.map((c) => ({ c, a: Math.atan2(R * c.dot(x), R * c.dot(z)) })).sort((u, v) => u.a - v.a).map((o) => o.c);
  let half = Infinity;
  const sag: number[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    half = Math.min(half, Math.abs(a[0] * (b[1] - a[1]) - a[1] * (b[0] - a[0])) / l);
    const m = sorted[k].clone().add(sorted[(k + 1) % pts.length]).normalize().multiplyScalar(R);
    const mx = m.dot(x) - (a[0] + b[0]) / 2, mz = m.dot(z) - (a[1] + b[1]) / 2;
    // signed bulge of the true edge past the chord, positive away from the cell centre
    const nxo = (b[1] - a[1]) / l, nzo = -(b[0] - a[0]) / l;
    const outward = nxo * (a[0] + b[0]) + nzo * (a[1] + b[1]) > 0 ? 1 : -1;
    sag.push(outward * (mx * nxo + mz * nzo));
  }
  return { poly, half, sag, quat };
}

const ringsFrom = (sphere: Sphere, start: number) => {
  const ringOf = new Array<number>(sphere.cells.length).fill(-1);
  ringOf[start] = 0;
  const queue = [start];
  for (let h = 0; h < queue.length; h++) {
    for (const j of sphere.cells[queue[h]].neighbours) if (ringOf[j] < 0) { ringOf[j] = ringOf[queue[h]] + 1; queue.push(j); }
  }
  return ringOf;
};

const layoutCache = new WeakMap<Agent[], Lattice>();

/** Pure layout from agent data: bands map to consecutive geodesic rings around the core cell. */
export function layoutLattice(agents: Agent[]): Lattice {
  const cached = layoutCache.get(agents);
  if (cached) return cached;
  const sphere = buildSphere(GLOBE_FREQ);
  const R = SQRT3 / sphere.meanSpacing;
  const n = sphere.cells.length;

  // geodesic rings: graph distance from the core cell
  const ringOf = ringsFrom(sphere, sphere.core);
  const azimuth = (i: number) => Math.atan2(sphere.cells[i].center[1], sphere.cells[i].center[0]);
  const ringSlots = (k: number) => sphere.cells.map((_, i) => i).filter((i) => ringOf[i] === k).sort((a, b) => azimuth(a) - azimuth(b));

  const slotOwner = new Map<number, Agent>();
  let nextRing = 0;
  for (const band of ['core', 't1', 'domain', 'gate'] as Band[]) {
    const members = agents.filter((a) => a.band === band).sort((a, b) => a.name.localeCompare(b.name));
    if (!members.length) continue;
    const rings: number[] = [];
    let cap = 0;
    while (cap < members.length) { rings.push(nextRing); cap += ringSlots(nextRing).length; nextRing++; }
    let placed = 0;
    rings.forEach((k, idx) => {
      const slots = ringSlots(k);
      const share = idx === rings.length - 1
        ? members.length - placed
        : Math.min(slots.length, Math.round((members.length * slots.length) / cap));
      for (let i = 0; i < share; i++) slotOwner.set(slots[Math.floor(((i + 0.5) * slots.length) / share)], members[placed + i]);
      placed += share;
    });
  }

  // the front hemisphere (the side facing the hive camera) ends at hemiRing; the moon grows after it
  const hemiRing = Math.max(...sphere.cells.map((c, i) => (c.center[2] >= 0 ? ringOf[i] : 0)));
  const maxRing = hemiRing + 1;

  const cells: Cell[] = [];
  sphere.cells.forEach((sc, i) => {
    const agent = slotOwner.get(i);
    const normal = new Vector3(...sc.center);
    const corners = sc.corners.map((c) => new Vector3(...c));
    const slots = ringSlots(ringOf[i]);
    const { poly, half, sag, quat } = polygonOf(corners, normal, R);
    cells.push({
      pos: normal.clone().multiplyScalar(R), normal, ring: ringOf[i], agent, height: RELIEF, base: RELIEF, reach: RELIEF, terrain: 0, neighbours: sc.neighbours,
      sweep: slots.indexOf(i) / slots.length, sides: sc.sides, poly, half, sag,
      scale: 1, bodyRadius: R, seam: SEAM_DEFAULT, quat, moon: false, corners,
    });
  });

  // moon: a small Goldberg sphere beside the globe, showroom on the cell that faces the hive camera, its workers on the rings around it
  const sats = agents.filter((a) => a.band === 'satellite')
    .sort((a, b) => (a.name === 'showroom' ? -1 : b.name === 'showroom' ? 1 : a.name.localeCompare(b.name)));
  const centre = MOON_DIR.clone().multiplyScalar(R * MOON_OFFSET);
  const facing = HIVE_EYE.clone().multiplyScalar(R).sub(centre).normalize();
  let moonRadius = 0;
  let moonCells = 0;
  if (sats.length) {
    const ms = buildSphere(MOON_FREQ);
    const Rm = (SQRT3 / ms.meanSpacing) * MOON_CELL;
    const rot = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), facing); // the moon's core cell (+Z) turns towards the camera
    const mring = ringsFrom(ms, ms.core);
    const order = ms.cells.map((_, i) => i).sort((a, b) => mring[a] - mring[b] || Math.atan2(ms.cells[a].center[1], ms.cells[a].center[0]) - Math.atan2(ms.cells[b].center[1], ms.cells[b].center[0]));
    const owner = new Map<number, Agent>();
    sats.slice(0, order.length).forEach((a, k) => owner.set(order[k], a));
    ms.cells.forEach((sc, i) => {
      const normal = new Vector3(...sc.center).applyQuaternion(rot);
      const corners = sc.corners.map((c) => new Vector3(...c).applyQuaternion(rot));
      const { poly, half, sag, quat } = polygonOf(corners, normal, Rm);
      cells.push({
        pos: centre.clone().addScaledVector(normal, Rm), normal, ring: maxRing, agent: owner.get(i), height: RELIEF, base: RELIEF, reach: RELIEF, terrain: 0, neighbours: sc.neighbours.map((j) => n + j),
        sweep: i / ms.cells.length, sides: sc.sides, poly, half, sag, scale: 1, bodyRadius: Rm, seam: SEAM_DEFAULT * MOON_CELL,
        quat, moon: true, corners,
        home: { pos: centre.clone().addScaledVector(normal, Rm), normal: normal.clone(), quat: quat.clone() },
      });
    });
    moonRadius = Rm + RELIEF;
    moonCells = ms.cells.length;
  }

  cells.forEach((c) => {
    const fp = footprint(c, c.seam);
    c.scale = fp.reduce((m, _, k) => (k % 2 ? m : Math.max(m, Math.hypot(fp[k], fp[k + 1]))), 0) / CELL_RADIUS;
  });
  const hexRadii = cells.filter((c) => !c.moon && c.sides === 6).map((c) => c.scale * CELL_RADIUS);
  const lattice: Lattice = {
    cells, agentCount: cells.filter((c) => c.agent).length, maxRing, radius: R,
    cellRadius: hexRadii.reduce((a, b) => a + b, 0) / hexRadii.length,
    moon: { centre, normal: facing, radius: moonRadius, cells: moonCells, pos: centre.clone(), angle: 0, driftMax: 0 },
    pentagons: cells.filter((c) => !c.moon && c.sides === 5).length,
  };
  applyTerrain(lattice);
  layoutCache.set(agents, lattice);
  return lattice;
}

const MAX_TOP = 0.9; // the tallest resting column stands at most this far above its sphere (a cell is about 1.7 across); a piston adds look.cell.stroke on top
const AGENT_BREATH = 0.02; // amplitude of the slow breath of an agent panel, world units
const MOON_AMP = 0.5; // the moon's relief is this fraction of the globe's
const terrainKeyOf = new WeakMap<Lattice, string>();

/**
 * Column resting heights (quantised into look.cell.steps levels) from a deterministic terrain (terrain.ts) sampled on each cell's normal. Writes cell.base and cell.reach, and resets cell.height (which cellTopOf and so
 * the comet, the label cards and picking all read) and cell.terrain. Agents are towers: their base stands above the highest a rod can reach (relief + elevation + stroke, plus look.cell.towerLift
 * and one look.cell.towerStep per tier below core), so fillers pump below them and never meet a cap. Returns false when nothing changed since the last call.
 */
export function applyTerrain(lattice: Lattice): boolean {
  const { relief, elevation, terrainScale, stroke } = look.cell;
  const steps = Math.max(2, Math.round(look.cell.steps));
  const { towerLift, towerStep } = look.cell;
  const { moonStroke } = look.cell;
  const moonThrow = stroke * moonStroke; // the most a moon rod drives out
  const key = `${relief}|${elevation}|${terrainScale}|${steps}|${stroke}|${towerLift}|${towerStep}|${moonStroke}|${look.cell.moonDrift}`;
  if (terrainKeyOf.get(lattice) === key) return false;
  terrainKeyOf.set(lattice, key);
  const el = Math.min(elevation, Math.max(0, MAX_TOP - relief));
  for (const moon of [false, true]) {
    const cs = lattice.cells.filter((c) => c.moon === moon);
    if (!cs.length) continue;
    const t = terrainField(cs.map((c) => (c.home ?? c).normal), terrainScale * (moon ? 1.6 : 1), moon ? 71 : 13);
    const amp = el * (moon ? MOON_AMP : 1);
    cs.forEach((c, i) => {
      // basalt: heights snap to `steps` levels (lowest and tallest both present), so neighbours read as stepped columns
      const q = Math.min(steps - 1, Math.floor(t[i] * steps)) / (steps - 1);
      c.terrain = q;
      // towers clear the tallest filler (resting top plus a full stroke); on the moon that is its own, smaller stroke, at the moon's scale
      const tower = moon
        ? relief + amp + moonThrow + MOON_AMP * towerLift
        : relief + el + stroke + towerLift + towerStep * (c.agent ? TOWER_RANK[c.agent.band] : 0);
      c.base = c.agent ? tower : relief + amp * q;
      c.height = c.base;
      // fillers stroke (the moon's at moonStroke of the globe's); towers breathe on the globe and stand steady on the moon
      c.reach = c.base + (c.agent ? (moon ? 0 : AGENT_BREATH) : moon ? moonThrow : stroke);
    });
  }
  lattice.moon.driftMax = moonDriftAmp(lattice);
  return true;
}

// ---- the moon's own motion --------------------------------------------------------------------------------------------------
// The moon spins about its own axis and drifts along a small tilted ellipse round its home. It writes the LIVE pose of every moon cell
// (pos, normal, quat) from the parked one in cell.home, so cellTopOf, picking, rings and the label cards follow without knowing about it.
const MOON_AXIS = new Vector3(0.22, 1, 0.1).normalize(); // the moon's spin axis (in the globe's frame), tilted off vertical
const MOON_DRIFT_TILT = 0.35; // rad the ellipse's minor axis leans out of the tangent plane (a little radial travel)
const MOON_DRIFT_MINOR = 0.55; // minor / major axis
const MOON_DRIFT_SPIN = 0.3; // rad the major axis is turned about the moon's outward direction, so the path is not a horizontal loop
const MOON_CLEAR = 0.3; // world units of air kept between the moon (fully drifted) and the globe's tallest reach
const dirHome = MOON_DIR.clone();
const driftU = new Vector3(), driftV = new Vector3();
{
  const t1 = new Vector3().crossVectors(dirHome, new Vector3(0, 1, 0)).normalize();
  const t2 = new Vector3().crossVectors(dirHome, t1).normalize();
  driftU.copy(t1).multiplyScalar(Math.cos(MOON_DRIFT_SPIN)).addScaledVector(t2, Math.sin(MOON_DRIFT_SPIN)).normalize();
  const w = new Vector3().crossVectors(dirHome, driftU).normalize();
  driftV.copy(w).multiplyScalar(Math.cos(MOON_DRIFT_TILT)).addScaledVector(dirHome, Math.sin(MOON_DRIFT_TILT)).multiplyScalar(MOON_DRIFT_MINOR);
}

/** Largest drift distance (world units) of the moon centre from home: look.cell.moonDrift globe radii, capped so the moon can never reach the globe.
 *  Every drift step is tangential except the small radial share of the minor axis, so the closest approach is at least |centre| - A * radialShare. */
function moonDriftAmp(l: Lattice): number {
  const globeReach = l.radius + Math.max(0, ...l.cells.filter((c) => !c.moon).map((c) => c.reach));
  const moonReach = l.moon.radius + Math.max(0, ...l.cells.filter((c) => c.moon).map((c) => c.reach));
  const gap = l.moon.centre.length() - globeReach - moonReach - MOON_CLEAR;
  const radial = MOON_DRIFT_MINOR * Math.sin(MOON_DRIFT_TILT);
  return Math.max(0, Math.min(look.cell.moonDrift * l.radius, gap / radial));
}

/** Drift offset at ellipse phase `phase` (radians), scaled by `weight` (0 = exactly home). */
export function moonDriftAt(l: Lattice, phase: number, weight: number, out = new Vector3()): Vector3 {
  if (weight <= 0) return out.set(0, 0, 0);
  const a = l.moon.driftMax * weight;
  return out.copy(driftU).multiplyScalar(Math.cos(phase) * a).addScaledVector(driftV, Math.sin(phase) * a);
}

const spinQ = new Quaternion();
/** Write the live pose of the moon: spin `angle` about its own centre, centre moved by `drift`. angle 0 with drift 0 restores the layout pose exactly. */
export function setMoonPose(l: Lattice, angle: number, drift: Vector3): void {
  const m = l.moon;
  m.angle = angle;
  m.pos.copy(m.centre).add(drift);
  const home = angle === 0;
  spinQ.setFromAxisAngle(MOON_AXIS, angle);
  for (const c of l.cells) {
    if (!c.moon || !c.home) continue;
    if (home) c.normal.copy(c.home.normal); else c.normal.copy(c.home.normal).applyQuaternion(spinQ);
    c.pos.copy(m.pos).addScaledVector(c.normal, c.bodyRadius);
    if (home) c.quat.copy(c.home.quat); else c.quat.copy(c.home.quat).premultiply(spinQ);
  }
}

const AO_RANGE = 1.0; // a neighbour this much taller (world units) shadows a top fully
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export interface Honeycomb {
  /** root object: two instanced panel meshes (hex, pentagon) sharing one material, plus the dark seam floors */
  object: Group;
  /** GTAO's G-buffer scene content (round 11, high tier only): the same panels and floors, unparented, normal-material only.
   *  post.ts adds it to its own private scene; the caller (world.ts) keeps its spin in sync with the globe's. */
  aoGroup: Group | null;
  /** the pickable instanced meshes */
  meshes: InstancedMesh[];
  /** cell index for an instance of one of `meshes` */
  cellAt(mesh: unknown, instanceId: number): number;
  lattice: Lattice;
  /** growth 0..1 drives the ring-by-ring rise; dim 0..1 darkens the lattice; `time` (seconds) runs the pistons, the agent breath and the
   *  moon's spin and drift (omitted: every column rests at its base height and the moon sits at home, which is what reduced-motion style callers want).
   *  `moonWeight` 0..1 (default 1) is how freely the moon moves: 0 parks it exactly at home, in between it eases there (see world.ts, spinWeight). */
  update(growth: number, dim: number, time?: number, moonWeight?: number, walkWeight?: number): void;
  /** radial wall extrusion 0..1 (0 = straight prisms). Shared by the lit, shadow and AO shapes. */
  setRadial(k: number): void;
  /** multiplies the globe's emissive seam floor (1 = as tuned): dimmed under the walk camera so bloom does not bleed through the seams */
  setCoreScale(k: number): void;
  material: MeshPhysicalMaterial;
  uniforms: CellUniforms;
  /** re-read look.cell into the material uniforms (and rebuild the seam footprints when the seam slider moved) */
  syncLook(): void;
  /** per-instance state: tone brightening 0..1 and lift 0..1 (scaled by look.cell.lift). Never self-lit. */
  setCellState(i: number, bright: number, lift: number): void;
  dispose(): void;
}

/** Rings of the rounded top edge: angle of each ring on the quarter-circle fillet, wall (0) to top face (90 degrees). */
const FILLET = [0, 22.5, 45, 67.5, 90].map((d) => (d * Math.PI) / 180);

/**
 * Prism with a hairline filleted top edge: flat-shaded walls, a quarter-round edge in four steps with smooth normals, and a top cap.
 * The unit geometry is a regular polygon of circumradius 1 (used for picking); the vertex shader (cell-material.ts) replaces every
 * corner with the instance's own Voronoi corner (aK = corner index, -1 = centre) and applies the fillet size in world units:
 * aBev.x drops a ring by (1 - sin a), aBev.y insets it by (1 - cos a), both times the bevel.
 */
function prism(sides: 5 | 6): BufferGeometry {
  const R = CELL_RADIUS;
  const pos: number[] = [], nor: number[] = [], bev: number[] = [], kk: number[] = [], idx: number[] = [];
  const vert = (k: number, y: number, nx: number, ny: number, nz: number, bx: number, by: number) => {
    const a = (k / sides) * Math.PI * 2;
    pos.push(k < 0 ? 0 : R * Math.sin(a), y, k < 0 ? 0 : R * Math.cos(a)); nor.push(nx, ny, nz); bev.push(bx, by); kk.push(k < 0 ? -1 : k % sides);
    return pos.length / 3 - 1;
  };
  for (let k = 0; k < sides; k++) {
    const m = ((k + 0.5) / sides) * Math.PI * 2;
    const nx = Math.sin(m), nz = Math.cos(m);
    // wall, from the base to the top of the wall (where the fillet starts)
    const wall = [[k, 0], [k + 1, 0], [k + 1, 1], [k, 1]].map(([c, y]) => vert(c, y, nx, 0, nz, y, 0));
    idx.push(wall[0], wall[1], wall[2], wall[0], wall[2], wall[3]);
    // fillet rings, each with the normal tilted from the wall toward the top face
    let prev = [wall[3], wall[2]];
    for (let i = 1; i < FILLET.length; i++) {
      const f = FILLET[i], c = Math.cos(f), sn = Math.sin(f);
      const bx = 1 - sn, by = 1 - c;
      const row = [k, k + 1].map((a) => vert(a, 1, nx * c, sn, nz * c, bx, by));
      idx.push(prev[0], prev[1], row[1], prev[0], row[1], row[0]);
      prev = row;
    }
    // top cap
    const t0 = vert(k, 1, 0, 1, 0, 0, 1);
    const t1 = vert(k + 1, 1, 0, 1, 0, 0, 1);
    const tc = vert(-1, 1, 0, 1, 0, 0, 0);
    idx.push(tc, t0, t1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nor, 3));
  g.setAttribute('aBev', new Float32BufferAttribute(bev, 2));
  g.setAttribute('aK', new Float32BufferAttribute(kk, 1));
  g.setIndex(idx);
  return g;
}

// mulberry32: a fixed random layout per cell index, so screenshots and tier switches agree
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothIO = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// integer hash to 0..1, for a per-(cell, cycle) decision
const hash01 = (a: number, b: number) => {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

interface Piston { r0: number; spiral: number; rho: number; agentPhase: number }

/**
 * Reactor-rod stroke of a filler column, 0..1 of its throw: hold low, a fast eased drive out, hold high, a slower eased retract.
 * One cycle is look.cell.pistonSpeed seconds; `activity` is the share of it spent moving, the rest is held. The phase mixes a per-cell
 * random offset with a slow wave over the sphere (`wave`), so rods fire in sweeping sequences rather than all at once or as noise.
 * Each cycle a rod skips with a fixed chance or throws a half or a full stroke (decided while it rests low, so nothing jumps);
 * the holds sit exactly at the base and at base + half or full stroke, so the stepped read stays.
 */
function stroke(ci: number, pi: Piston, t: number): number {
  const { pistonSpeed, activity, wave } = look.cell;
  const phase = t / Math.max(1, pistonSpeed) + (1 - wave) * pi.r0 + wave * pi.spiral;
  const k = Math.floor(phase);
  const u = phase - k;
  const roll = hash01(ci, k);
  if (roll < 0.3) return 0; // this cycle the rod stays put
  const throwFrac = roll < 0.65 ? 0.5 : 1;
  const a = Math.min(0.9, Math.max(0.02, activity));
  const drive = a * 0.3, retract = a * 0.7;
  const low = (1 - a) * pi.rho, high = (1 - a) * (1 - pi.rho);
  let h: number;
  if (u < low) h = 0;
  else if (u < low + drive) { const x = (u - low) / drive; h = 1 - Math.pow(1 - x, 3); } // fast drive out, settling
  else if (u < low + drive + high) h = 1;
  else h = 1 - smoothIO((u - low - drive - high) / retract);
  return h * throwFrac;
}

export function createHoneycomb(agents: Agent[], tier: Tier = 'high', renderer?: WebGLRenderer): Honeycomb {
  const lattice = layoutLattice(agents);
  setMoonPose(lattice, 0, new Vector3()); // the lattice is shared and cached: start from the parked pose whatever the last honeycomb left
  const palette = readPalette();
  const cellMat = createCellMaterial(tier, palette, look.cell);
  const { material } = cellMat;
  // procedural studio reflection (round 11: both tiers, metal needs something to reflect), only when the caller can give us the renderer to bake it with
  const env = renderer ? createStudioEnv(renderer, palette) : null;
  // cast shadows are high tier only (world.ts turns the shadow map on for it); medium darkens tops beside taller neighbours instead
  const shadows = tier === 'high';
  const depthMat = shadows ? createCellDepthMaterial(cellMat.uniforms) : null;
  // GTAO's own G-buffer (high tier only): a normal-material twin of the panels, mirroring cell-depth.ts's shadow-depth trick
  const normalMat = tier === 'high' ? createCellNormalMaterial(cellMat.uniforms) : null;
  const useAO = tier === 'medium';
  if (env) material.envMap = env.texture;

  const attr = (n: number, count: number, dynamic = false) => {
    const a = new InstancedBufferAttribute(new Float32Array(n * count), n ? count : count);
    if (dynamic) a.setUsage(DynamicDrawUsage);
    return a;
  };
  const kinds = ([6, 5] as const).map((sides) => {
    const cellIdx = lattice.cells.flatMap((c, i) => (c.sides === sides ? [i] : []));
    const geometry = prism(sides);
    const cnt = cellIdx.length;
    const state = attr(cnt, 3, true); // bright, lift, ambient occlusion (medium tier)
    const stone = attr(cnt, 4); // rotation, offset u, offset v, 1 / body radius
    const rock = attr(cnt, 2); // terrain value 0..1, band tone step (agents)
    const inlay = attr(cnt, 4); // agent flag (1 = polished facet), -, -, panel half width
    const corners = [attr(cnt, 4, true), attr(cnt, 4, true), attr(cnt, 4, true)];
    geometry.setAttribute('aState', state);
    geometry.setAttribute('aStone', stone);
    geometry.setAttribute('aInlay', inlay);
    geometry.setAttribute('aRock', rock);
    ['aCornA', 'aCornB', 'aCornC'].forEach((n, k) => geometry.setAttribute(n, corners[k]));
    const mesh = new InstancedMesh(geometry, material, cnt);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    if (shadows) { mesh.castShadow = true; mesh.receiveShadow = true; mesh.customDepthMaterial = depthMat!; } // the depth pass must run the cells' own vertex shader
    // GTAO's twin: shares this mesh's own instanceMatrix (not the geometry's instanced attributes, which are already shared
    // by both meshes reading `geometry`), so it never needs its own per-frame update
    let gMesh: InstancedMesh | null = null;
    if (normalMat) {
      gMesh = new InstancedMesh(geometry, normalMat, cnt);
      gMesh.instanceMatrix = mesh.instanceMatrix; // the default one it allocated is never uploaded, so just drops
      gMesh.frustumCulled = false;
    }
    return { cellIdx, geometry, state, stone, inlay, rock, corners, mesh, gMesh };
  });
  const slotOf = new Map<number, { k: number; slot: number }>();
  kinds.forEach((kd, k) => kd.cellIdx.forEach((ci, slot) => slotOf.set(ci, { k, slot })));

  kinds.forEach((kd) => kd.cellIdx.forEach((ci, slot) => {
    const c = lattice.cells[ci];
    const r = rng(ci * 7919 + 13);
    // every panel is its own stone piece: a random rotation and offset into the (shared) speckle field
    kd.stone.setXYZW(slot, r() * Math.PI * 2, r() * 97, r() * 97, 1 / c.bodyRadius);
    kd.inlay.setXYZW(slot, c.agent ? 1 : 0, 0, 0, c.half);
    kd.rock.setXY(slot, c.terrain, c.agent ? BAND_STEP[c.agent.band] : 0);
  }));

  let lastSeam = NaN;
  const setFootprints = (seam: number) => {
    const tmp: number[] = [];
    kinds.forEach((kd) => {
      kd.cellIdx.forEach((ci, slot) => {
        const c = lattice.cells[ci];
        const fp = insetPolygon(c.poly, (c.moon ? seam * MOON_CELL : seam) / 2, tmp, c.sag);
        const at = (k: number) => (k < fp.length ? fp[k] : fp[0]);
        kd.corners[0].setXYZW(slot, at(0), at(1), at(2), at(3));
        kd.corners[1].setXYZW(slot, at(4), at(5), at(6), at(7));
        kd.corners[2].setXYZW(slot, at(8), at(9), at(10), at(11));
      });
      kd.corners.forEach((a) => (a.needsUpdate = true));
    });
  };

  // per-cell piston constants: a fixed random layout, plus each cell's place on a slow spiral wave round the globe axis
  const pistons: Piston[] = lattice.cells.map((c, ci) => {
    const r = rng(ci * 104729 + 7);
    const n = (c.home ?? c).normal;
    return { r0: r(), spiral: Math.atan2(n.x, n.z) / (Math.PI * 2) + 0.6 * n.y, rho: 0.3 + 0.4 * r(), agentPhase: r() * Math.PI * 2 };
  });

  const ringSpan = Math.max(1, lattice.maxRing);
  // ring k starts at (k-1)/maxRing of the growth range; ring 0 is always present; the back hemisphere grows with the limb
  const startOf = (c: Cell) => {
    const ring = c.moon ? lattice.maxRing : Math.min(c.ring, lattice.maxRing - 1);
    return ring === 0 ? -1 : ((ring - 1) / ringSpan) * 0.72 + c.sweep * 0.06;
  };

  // Seam floors: matte spheres just under each body. They hide the far side through the seams, so the engraved seams
  // read as recessed channels. The moon's stays dark ink; the globe's (round 11) is a faint HDR emissive core, a cool
  // iron-blue light glowing through its seams (never the comet's accent), so bloom catches it. It follows view.dim.
  const coreColorOf = (core: Look['core']) =>
    new Color(palette.ink2).lerp(new Color(palette.waxDim).lerp(new Color(palette.text), core.color), 0.7).multiplyScalar(core.intensity);
  const coreMat = new MeshBasicMaterial({ color: coreColorOf(look.core), fog: false });
  const moonMat = new MeshBasicMaterial({ color: new Color(palette.ink), fog: false });
  const floorGeos: SphereGeometry[] = [];
  const floors: Mesh[] = [];
  let moonFloor: Mesh | null = null;
  const addFloor = (radius: number, mat: MeshBasicMaterial, at?: Vector3) => {
    const g = new SphereGeometry(radius - SINK * 0.5, 96, 48);
    floorGeos.push(g);
    const m = new Mesh(g, mat);
    if (at) m.position.copy(at);
    floors.push(m);
    return m;
  };
  addFloor(lattice.radius, coreMat);
  const moonCell = lattice.cells.find((c) => c.moon);
  if (moonCell) moonFloor = addFloor(moonCell.bodyRadius, moonMat, lattice.moon.pos);

  const object = new Group();
  object.add(...floors, ...kinds.map((kd) => kd.mesh));
  // GTAO's G-buffer twin (round 11, high tier only): the same floors and panels, normal-material only, never added to `object`
  // or the real scene (world.ts keeps its spin in sync with the globe's; post.ts owns and renders it)
  let aoGroup: Group | null = null;
  let gFloorMat: MeshNormalMaterial | null = null;
  if (normalMat) {
    aoGroup = new Group();
    gFloorMat = new MeshNormalMaterial();
    const gFloors = floorGeos.map((g) => new Mesh(g, gFloorMat!));
    gFloors.forEach((m, i) => m.position.copy(floors[i].position));
    aoGroup.add(...gFloors, ...kinds.flatMap((kd) => (kd.gMesh ? [kd.gMesh] : [])));
  }

  const m = new Matrix4();
  const p = new Vector3();
  const sc = new Vector3();
  let lastGrowth = NaN, lastDim = NaN, lastTime = NaN, wasTimed = false;
  let dirty = true;
  const drift = new Vector3();
  // The moon's free-running spin, parked exactly like the globe's (world.ts stepSpin): `free` advances at rate * weight; the shown angle is
  // lerp(home, free, weight), home being the nearest multiple of 2 pi latched when the weight starts to drop, so it eases home (at most half a turn)
  // and never jumps; at weight 0 it is exactly home, drift included (the drift is scaled by the weight), so the parked layout is the layout.
  let moonFree = 0, moonHome = 0, moonWPrev = 1, moonT = NaN;
  const stepMoon = (time: number, w: number) => {
    const dt = Number.isNaN(moonT) ? 0 : Math.max(0, Math.min(0.1, time - moonT));
    moonT = time;
    if (w < 1 && moonWPrev >= 1) moonHome = Math.round(moonFree / (Math.PI * 2)) * Math.PI * 2;
    moonWPrev = w;
    moonFree += ((Math.PI * 2) / Math.max(1, look.cell.moonTurnSec)) * w * dt;
    if (w <= 0) moonFree = moonHome = 0;
    const angle = w <= 0 ? 0 : moonHome + (moonFree - moonHome) * w;
    moonDriftAt(lattice, (time * Math.PI * 2) / motion.moon.driftSec, w, drift);
    setMoonPose(lattice, angle, drift);
    moonFloor?.position.copy(lattice.moon.pos);
  };
  const whiteBase = material.color.clone();
  const coreBase = coreMat.color.clone();
  let coreScale = 1;

  return {
    object,
    aoGroup,
    meshes: kinds.map((kd) => kd.mesh),
    cellAt: (mesh, id) => kinds.find((kd) => kd.mesh === mesh)?.cellIdx[id] ?? -1,
    lattice,
    material,
    uniforms: cellMat.uniforms,
    syncLook() { cellMat.sync(look.cell); coreMat.color.copy(coreColorOf(look.core)).multiplyScalar(coreScale); },
    setRadial(k) { cellMat.uniforms.uRadial.value = k; },
    setCoreScale(k) { coreScale = k; lastDim = NaN; coreMat.color.copy(coreColorOf(look.core)).multiplyScalar(k); },
    setCellState(i, bright, lf) {
      const s = slotOf.get(i);
      if (!s) return;
      const kd = kinds[s.k];
      kd.state.setXY(s.slot, bright, lf * look.cell.lift); // (z, the occlusion, is left alone)
      kd.state.needsUpdate = true;
    },
    update(growth, dim, time, moonWeight = 1, walk = 0) {
      if (look.cell.seam !== lastSeam) { lastSeam = look.cell.seam; setFootprints(look.cell.seam); }
      if (applyTerrain(lattice)) {
        dirty = true;
        kinds.forEach((kd) => {
          kd.cellIdx.forEach((ci, slot) => kd.rock.setXY(slot, lattice.cells[ci].terrain, lattice.cells[ci].agent ? BAND_STEP[lattice.cells[ci].agent!.band] : 0));
          kd.rock.needsUpdate = true;
        });
      }
      const timed = time !== undefined;
      const moving = timed && time !== lastTime;
      if (timed !== wasTimed) {
        wasTimed = timed; dirty = true; // back to rest when the time stops coming, the moon too
        if (!timed) { moonFree = moonHome = 0; moonT = NaN; moonWPrev = 1; setMoonPose(lattice, 0, drift.set(0, 0, 0)); moonFloor?.position.copy(lattice.moon.pos); }
      }
      if (timed) lastTime = time;
      if (timed && moving) stepMoon(time, moonWeight); // (a second call in the same frame, e.g. the dissolve's other half, leaves the pose alone)
      if (growth !== lastGrowth || dirty || moving) {
        lastGrowth = growth;
        dirty = false;
        kinds.forEach((kd) => {
          kd.cellIdx.forEach((ci, slot) => {
            const c = lattice.cells[ci];
            // agents: towers, breathing on the globe and steady on the moon; fillers: pistons, the moon's at moonStroke of the globe's throw
            if (time === undefined || (c.moon && c.agent)) c.height = c.base;
            else if (c.agent) c.height = c.base + (1 - walk) * AGENT_BREATH * Math.sin(time * 0.55 + pistons[ci].agentPhase) + walk * walkCfg.towerGrow; // under the walker the towers stand taller (walkCfg.towerGrow), so they read as pillars
            else c.height = c.base + (1 - walk) * look.cell.stroke * (c.moon ? look.cell.moonStroke : 1) * stroke(ci, pistons[ci], time); // walk 0..1 parks the rods at rest
            const s = ease((growth - startOf(c)) / 0.28);
            // flush growth: the panel rises out of the seam floor, ring by ring, widening as it comes up; no scale on the height
            const rise = (1 - s) * 0.5;
            p.copy(c.normal).multiplyScalar(-(SINK + rise)).add(c.pos);
            const w = s <= 0.001 ? 1e-4 : 0.6 + 0.4 * s;
            sc.set(w, c.height + SINK, w); // each column has its own height
            kd.mesh.setMatrixAt(slot, m.compose(p, c.quat, sc));
          });
          kd.mesh.instanceMatrix.needsUpdate = true;
        });
        if (useAO) {
          // how much taller the neighbours are, relative to a column's own height: 0 on a summit, up to 1 at the bottom of a well
          kinds.forEach((kd) => {
            kd.cellIdx.forEach((ci, slot) => {
              const c = lattice.cells[ci];
              let sum = 0;
              for (const j of c.neighbours) sum += Math.min(1, Math.max(0, (lattice.cells[j].height - c.height) / AO_RANGE));
              kd.state.setZ(slot, c.neighbours.length ? sum / c.neighbours.length : 0);
            });
            kd.state.needsUpdate = true;
          });
        }
      }
      if (dim !== lastDim) {
        lastDim = dim;
        material.color.copy(whiteBase).multiplyScalar(1 - 0.65 * dim);
        coreMat.color.copy(coreBase).multiplyScalar((1 - 0.65 * dim) * coreScale); // the core follows the proof-chapter dim like the rest of the stone
      }
    },
    dispose() {
      kinds.forEach((kd) => { kd.geometry.dispose(); kd.mesh.dispose(); kd.gMesh?.dispose(); });
      floorGeos.forEach((g) => g.dispose());
      coreMat.dispose();
      moonMat.dispose();
      material.dispose();
      depthMat?.dispose();
      normalMat?.dispose();
      gFloorMat?.dispose();
      env?.dispose();
    },
  };
}
