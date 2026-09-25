import {
  CylinderGeometry, Color, DynamicDrawUsage, Float32BufferAttribute, Group, InstancedBufferAttribute, InstancedMesh, Matrix4,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, Quaternion, SphereGeometry, Vector3,
} from 'three';
import { CELL_RADIUS, look, readPalette, type Tier } from './config';
import { createCellMaterial, type CellUniforms } from './cell-material';
import { buildSphere } from './sphere';
import type { Agent } from '../agents';
import type { Band } from '../../content/tiers';

// The lattice is a Goldberg sphere (sphere.ts): hexagon and pentagon prisms extruded along the surface normal,
// plus a small moon cluster of flat hexes floating beside it. Cell circumradius is ~1 world unit.
const SQRT3 = Math.sqrt(3);
const GLOBE_FREQ = 4; // GP(4,0): 162 cells, 150 hex + 12 pentagons
const SINK = 0.12; // prisms start this far below the surface so seams never show a gap
const CELL_GAP = CELL_RADIUS; // prism radius; <1 leaves a visible seam
const LEAD_CORE = 1.0; // emissive strength per agent band (filler cells have none)
const AGENT_CORE = 0.7;
const GLOBE_HEIGHT = 0.6; // extrusion of globe cells relative to the old flat lattice: on a sphere tall columns read as spikes
const MOON_SCALE = 0.7; // moon cell size relative to a globe cell
const MOON_OFFSET = 1.85; // moon centre distance in globe radii
const MOON_DIR = new Vector3(0.86, 0.3, 0.4).normalize();

// height and grey per band (agents vs filler differ only by these two values)
const AGENT_STYLE: Record<Band, { h: number; grey: number }> = {
  core: { h: 1.8, grey: 0.95 },
  t1: { h: 1.1, grey: 0.85 },
  domain: { h: 0.9, grey: 0.75 },
  gate: { h: 1.1, grey: 0.85 },
  satellite: { h: 0.9, grey: 0.75 },
};
const FILLER = { h: 0.3, grey: 0.18 };

export interface Cell {
  /** base surface point of the prism (on the sphere, or on the moon plate) */
  pos: Vector3;
  /** outward unit normal: the prism extrudes along it */
  normal: Vector3;
  /** geodesic ring index from the core cell (graph distance); moon cells use maxRing so they appear last */
  ring: number;
  agent?: Agent;
  height: number;
  grey: number;
  /** 0..1 stagger inside a ring so growth sweeps around */
  sweep: number;
  sides: 5 | 6;
  /** prism footprint scale (footprint circumradius = CELL_RADIUS * scale) */
  scale: number;
  /** orients the footprint: local +Y = normal, local +Z = towards a polygon corner */
  quat: Quaternion;
  moon: boolean;
  /** unit-sphere polygon corners (globe cells only) for outlines */
  corners?: Vector3[];
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
  moon: { centre: Vector3; normal: Vector3; radius: number };
  pentagons: number;
}

/** World-space top of a cell (prism apex centre). */
export const cellTopOf = (c: Cell, out = new Vector3()): Vector3 => out.copy(c.normal).multiplyScalar(c.height).add(c.pos);

const basisQuat = (y: Vector3, z: Vector3) => {
  const x = new Vector3().crossVectors(y, z).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, new Vector3().crossVectors(x, y)));
};

// pointy-top axial hex spiral for the moon cluster (circumradius 1, centre spacing sqrt(3))
const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
function ringCells(k: number): [number, number][] {
  if (k === 0) return [[0, 0]];
  const out: [number, number][] = [];
  let q = -k, r = k;
  for (let i = 0; i < 6; i++) for (let j = 0; j < k; j++) {
    out.push([q, r]);
    q += DIRS[i][0]; r += DIRS[i][1];
  }
  return out;
}

const layoutCache = new WeakMap<Agent[], Lattice>();

/** Pure layout from agent data: bands map to consecutive geodesic rings around the core cell. */
export function layoutLattice(agents: Agent[]): Lattice {
  const cached = layoutCache.get(agents);
  if (cached) return cached;
  const sphere = buildSphere(GLOBE_FREQ);
  const R = SQRT3 / sphere.meanSpacing;
  const n = sphere.cells.length;

  // geodesic rings: graph distance from the core cell
  const ringOf = new Array<number>(n).fill(-1);
  ringOf[sphere.core] = 0;
  const queue = [sphere.core];
  for (let h = 0; h < queue.length; h++) {
    for (const j of sphere.cells[queue[h]].neighbours) if (ringOf[j] < 0) { ringOf[j] = ringOf[queue[h]] + 1; queue.push(j); }
  }
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
    const s = agent ? AGENT_STYLE[agent.band] : FILLER;
    const normal = new Vector3(...sc.center);
    const slots = ringSlots(ringOf[i]);
    const dists = sc.neighbours.map((j) => Math.hypot(
      sc.center[0] - sphere.cells[j].center[0], sc.center[1] - sphere.cells[j].center[1], sc.center[2] - sphere.cells[j].center[2]));
    const apothem = (R * (0.5 * (dists.reduce((a, b) => a + b, 0) / dists.length) + 0.5 * Math.min(...dists))) / 2; // mean and nearest neighbour: never overlaps a closer one
    const corners = sc.corners.map((c) => new Vector3(...c));
    const toCorner = corners[0].clone().addScaledVector(normal, -corners[0].dot(normal)).normalize();
    cells.push({
      pos: normal.clone().multiplyScalar(R), normal, ring: ringOf[i], agent, height: s.h * GLOBE_HEIGHT, grey: s.grey,
      sweep: slots.indexOf(i) / slots.length, sides: sc.sides, scale: apothem / Math.cos(Math.PI / sc.sides),
      quat: basisQuat(normal, toCorner), moon: false, corners,
    });
  });

  // moon cluster: hexes on a small plate beside the globe, showroom at the centre, its workers around it
  const sats = agents.filter((a) => a.band === 'satellite')
    .sort((a, b) => (a.name === 'showroom' ? -1 : b.name === 'showroom' ? 1 : a.name.localeCompare(b.name)));
  const centre = MOON_DIR.clone().multiplyScalar(R * MOON_OFFSET);
  const moonNormal = centre.clone().normalize().add(new Vector3(0.05, 0.35, 1).normalize()).normalize(); // turned towards the hive camera
  const up = new Vector3(0, 1, 0).addScaledVector(moonNormal, -moonNormal.y).normalize();
  const right = new Vector3().crossVectors(moonNormal, up);
  const moonQuat = basisQuat(moonNormal, up);
  let moonRadius = 0;
  if (sats.length) {
    const spiral: [number, number][] = [];
    for (let k = 0; spiral.length < Math.max(sats.length, 7); k++) spiral.push(...ringCells(k));
    spiral.forEach(([q, r], i) => {
      const x = SQRT3 * (q + r / 2) * MOON_SCALE, z = 1.5 * r * MOON_SCALE;
      const agent = sats[i];
      const s = agent ? AGENT_STYLE.satellite : FILLER;
      const pos = centre.clone().addScaledVector(right, x).addScaledVector(up, z);
      moonRadius = Math.max(moonRadius, pos.distanceTo(centre) + MOON_SCALE);
      cells.push({
        pos, normal: moonNormal.clone(), ring: maxRing, agent, height: s.h * MOON_SCALE, grey: s.grey,
        sweep: i / spiral.length, sides: 6, scale: MOON_SCALE, quat: moonQuat.clone(), moon: true,
      });
    });
  }

  const hexRadii = cells.filter((c) => !c.moon && c.sides === 6).map((c) => c.scale * CELL_RADIUS);
  const lattice: Lattice = {
    cells, agentCount: cells.filter((c) => c.agent).length, maxRing, radius: R,
    cellRadius: hexRadii.reduce((a, b) => a + b, 0) / hexRadii.length,
    moon: { centre, normal: moonNormal, radius: moonRadius },
    pentagons: cells.filter((c) => c.sides === 5).length,
  };
  layoutCache.set(agents, lattice);
  return lattice;
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export interface Honeycomb {
  /** root object: two instanced prism meshes (hex, pentagon) sharing one material, plus a dark occluding core */
  object: Group;
  /** the pickable instanced meshes */
  meshes: InstancedMesh[];
  /** cell index for an instance of one of `meshes` */
  cellAt(mesh: unknown, instanceId: number): number;
  lattice: Lattice;
  /** growth 0..1 drives ring-by-ring extrusion; dim 0..1 darkens the lattice */
  update(growth: number, dim: number): void;
  material: MeshStandardMaterial;
  uniforms: CellUniforms;
  /** re-read look.cell into the material uniforms */
  syncLook(): void;
  /** per-instance state: core strength multiplier (added to base) and lift 0..1 (scaled by look.cell.lift) */
  setCellState(i: number, emissiveBoost: number, lift: number): void;
  dispose(): void;
}

function prism(sides: 5 | 6): CylinderGeometry {
  const g = new CylinderGeometry(CELL_GAP, CELL_GAP, 1, sides, 1);
  g.translate(0, 0.5, 0); // origin at the base so scaling Y extrudes outward
  g.setAttribute('aSides', new Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(sides), 1));
  return g;
}

export function createHoneycomb(agents: Agent[], tier: Tier = 'high'): Honeycomb {
  const lattice = layoutLattice(agents);
  const palette = readPalette();
  const cellMat = createCellMaterial(tier, palette, look.cell);
  const { material } = cellMat;
  const waxColor = material.color.clone();

  const kinds = ([6, 5] as const).map((sides) => {
    const cellIdx = lattice.cells.flatMap((c, i) => (c.sides === sides ? [i] : []));
    const geometry = prism(sides);
    const emissive = new InstancedBufferAttribute(new Float32Array(cellIdx.length), 1);
    const lift = new InstancedBufferAttribute(new Float32Array(cellIdx.length), 1);
    emissive.setUsage(DynamicDrawUsage);
    lift.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aEmissive', emissive);
    geometry.setAttribute('aLift', lift);
    const mesh = new InstancedMesh(geometry, material, cellIdx.length);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    return { cellIdx, geometry, emissive, lift, mesh };
  });
  const slotOf = new Map<number, { k: number; slot: number }>();
  kinds.forEach((kd, k) => kd.cellIdx.forEach((ci, slot) => slotOf.set(ci, { k, slot })));

  const baseEmissive = Float32Array.from(lattice.cells, (c) => (c.agent ? (c.agent.band === 'core' ? LEAD_CORE : AGENT_CORE) : 0));
  const tmp = new Color();
  kinds.forEach((kd) => kd.cellIdx.forEach((ci, slot) => {
    kd.emissive.setX(slot, baseEmissive[ci]);
    kd.mesh.setColorAt(slot, tmp.setScalar(lattice.cells[ci].grey));
  }));

  // dark core inside the globe: hides the far side through the seams (background colour, so seams still read as gaps)
  const coreGeo = new SphereGeometry(lattice.radius - SINK * 0.5, 48, 24);
  const coreMat = new MeshBasicMaterial({ color: palette.ink, fog: false });
  const core = new Mesh(coreGeo, coreMat);

  const object = new Group();
  object.add(core, ...kinds.map((kd) => kd.mesh));

  const m = new Matrix4();
  const p = new Vector3();
  const sc = new Vector3();
  let lastGrowth = NaN, lastDim = NaN;
  const ringSpan = Math.max(1, lattice.maxRing);

  return {
    object,
    meshes: kinds.map((kd) => kd.mesh),
    cellAt: (mesh, id) => kinds.find((kd) => kd.mesh === mesh)?.cellIdx[id] ?? -1,
    lattice,
    material,
    uniforms: cellMat.uniforms,
    syncLook: () => cellMat.sync(look.cell),
    setCellState(i, emissiveBoost, lf) {
      const s = slotOf.get(i);
      if (!s) return;
      const kd = kinds[s.k];
      kd.emissive.setX(s.slot, baseEmissive[i] + emissiveBoost);
      kd.lift.setX(s.slot, lf * look.cell.lift);
      kd.emissive.needsUpdate = true;
      kd.lift.needsUpdate = true;
    },
    update(growth, dim) {
      if (growth !== lastGrowth) {
        lastGrowth = growth;
        kinds.forEach((kd) => {
          kd.cellIdx.forEach((ci, slot) => {
            const c = lattice.cells[ci];
            const ring = c.moon ? lattice.maxRing : Math.min(c.ring, lattice.maxRing - 1); // the back hemisphere grows with the limb
            // ring 0 is always present; ring k starts at (k-1)/maxRing of the growth range
            const start = ring === 0 ? -1 : ((ring - 1) / ringSpan) * 0.72 + c.sweep * 0.06;
            const s = ease((growth - start) / 0.28);
            p.copy(c.normal).multiplyScalar(-SINK).add(c.pos);
            sc.set(Math.max(s * c.scale, 1e-4), Math.max(s * (c.height + SINK), 1e-4), Math.max(s * c.scale, 1e-4));
            kd.mesh.setMatrixAt(slot, m.compose(p, c.quat, sc));
          });
          kd.mesh.instanceMatrix.needsUpdate = true;
        });
      }
      if (dim !== lastDim) {
        lastDim = dim;
        material.color.copy(waxColor).multiplyScalar(1 - 0.65 * dim);
      }
    },
    dispose() {
      kinds.forEach((kd) => { kd.geometry.dispose(); kd.mesh.dispose(); });
      coreGeo.dispose();
      coreMat.dispose();
      material.dispose();
    },
  };
}
