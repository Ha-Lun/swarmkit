import {
  CylinderGeometry, Color, DynamicDrawUsage, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3,
} from 'three';
import type { Agent } from '../agents';
import type { Band } from '../../content/tiers';

// Pointy-top hex grid, axial coordinates, cell circumradius 1 (centre spacing sqrt(3)).
const SQRT3 = Math.sqrt(3);
const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const SKIRT_RINGS = 3; // filler rings beyond the outermost agent band
const SATELLITE_DIR = Math.PI / 6; // must match SAT in camera-path.ts
const SATELLITE_GAP = 4.5; // world units between lattice edge and cluster centre
const CELL_GAP = 0.94; // prism radius; <1 leaves a visible seam

// height and grey per band (agents vs filler differ only by these two values)
const AGENT_STYLE: Record<Band, { h: number; grey: number }> = {
  core: { h: 1.8, grey: 0.95 },
  t1: { h: 1.1, grey: 0.85 },
  domain: { h: 0.9, grey: 0.75 },
  gate: { h: 1.1, grey: 0.85 },
  satellite: { h: 0.9, grey: 0.75 },
};
const FILLER = { h: 0.3, grey: 0.32 };

export interface Cell {
  x: number;
  z: number;
  ring: number; // growth ring; satellites use the outermost ring so they appear last
  agent?: Agent;
  height: number;
  grey: number;
  /** 0..1 stagger inside a ring so growth sweeps around */
  sweep: number;
}

export interface Lattice {
  cells: Cell[];
  agentCount: number;
  maxRing: number;
  /** world radius of the main lattice including skirt */
  radius: number;
}

const axialToWorld = (q: number, r: number): [number, number] => [SQRT3 * (q + r / 2), 1.5 * r];

function ringCells(k: number): [number, number][] {
  if (k === 0) return [[0, 0]];
  const out: [number, number][] = [];
  let q = -k, r = k; // DIRS[4] * k
  for (let i = 0; i < 6; i++) for (let j = 0; j < k; j++) {
    out.push([q, r]);
    q += DIRS[i][0]; r += DIRS[i][1];
  }
  return out;
}
const ringCapacity = (k: number) => (k === 0 ? 1 : 6 * k);

/** Pure layout from agent data: bands map to consecutive rings, agents spread evenly around each ring. */
export function layoutLattice(agents: Agent[]): Lattice {
  const slotOwner = new Map<string, Agent>(); // "q,r" -> agent
  let nextRing = 0;
  for (const band of ['core', 't1', 'domain', 'gate'] as Band[]) {
    const members = agents.filter((a) => a.band === band).sort((a, b) => a.name.localeCompare(b.name));
    if (!members.length) continue;
    const rings: number[] = [];
    let cap = 0;
    while (cap < members.length) { rings.push(nextRing); cap += ringCapacity(nextRing); nextRing++; }
    let placed = 0;
    rings.forEach((k, idx) => {
      const share = idx === rings.length - 1
        ? members.length - placed
        : Math.min(ringCapacity(k), Math.round((members.length * ringCapacity(k)) / cap));
      const slots = ringCells(k);
      for (let i = 0; i < share; i++) {
        const [q, r] = slots[Math.floor(((i + 0.5) * slots.length) / share)];
        slotOwner.set(`${q},${r}`, members[placed + i]);
      }
      placed += share;
    });
  }

  const maxRing = Math.max(0, nextRing - 1) + SKIRT_RINGS;
  const cells: Cell[] = [];
  for (let k = 0; k <= maxRing; k++) {
    const slots = ringCells(k);
    slots.forEach(([q, r], i) => {
      const agent = slotOwner.get(`${q},${r}`);
      const s = agent ? AGENT_STYLE[agent.band] : FILLER;
      const [x, z] = axialToWorld(q, r);
      cells.push({ x, z, ring: k, agent, height: s.h, grey: s.grey, sweep: i / slots.length });
    });
  }

  // Satellite cluster: spiral cells around an off-lattice centre, agents first.
  const sats = agents.filter((a) => a.band === 'satellite')
    .sort((a, b) => (a.name === 'showroom' ? -1 : b.name === 'showroom' ? 1 : a.name.localeCompare(b.name)));
  const radius = maxRing * SQRT3;
  if (sats.length) {
    const cx = Math.cos(SATELLITE_DIR) * (radius + SATELLITE_GAP);
    const cz = Math.sin(SATELLITE_DIR) * (radius + SATELLITE_GAP);
    const spiral: [number, number][] = [];
    for (let k = 0; spiral.length < sats.length; k++) spiral.push(...ringCells(k));
    spiral.forEach(([q, r], i) => {
      const agent = sats[i];
      const s = agent ? AGENT_STYLE.satellite : FILLER;
      const [x, z] = axialToWorld(q, r);
      cells.push({ x: cx + x, z: cz + z, ring: maxRing, agent, height: s.h, grey: s.grey, sweep: i / spiral.length });
    });
  }

  return { cells, agentCount: cells.filter((c) => c.agent).length, maxRing, radius };
}

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export interface Honeycomb {
  mesh: InstancedMesh;
  lattice: Lattice;
  /** growth 0..1 drives ring-by-ring extrusion; dim 0..1 darkens the lattice */
  update(growth: number, dim: number): void;
  dispose(): void;
}

export function createHoneycomb(agents: Agent[]): Honeycomb {
  const lattice = layoutLattice(agents);
  const geometry = new CylinderGeometry(CELL_GAP, CELL_GAP, 1, 6, 1);
  geometry.translate(0, 0.5, 0); // origin at the base so scaling Y extrudes upward
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  const mesh = new InstancedMesh(geometry, material, lattice.cells.length);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  const tmp = new Color();
  lattice.cells.forEach((c, i) => mesh.setColorAt(i, tmp.setScalar(c.grey)));

  const m = new Matrix4();
  const q = new Quaternion();
  const p = new Vector3();
  const sc = new Vector3();
  let lastGrowth = NaN, lastDim = NaN;
  const ringSpan = Math.max(1, lattice.maxRing);

  return {
    mesh,
    lattice,
    update(growth, dim) {
      if (growth !== lastGrowth) {
        lastGrowth = growth;
        lattice.cells.forEach((c, i) => {
          // ring 0 is always present; ring k starts at (k-1)/maxRing of the growth range
          const start = c.ring === 0 ? -1 : ((c.ring - 1) / ringSpan) * 0.72 + c.sweep * 0.06;
          const s = ease((growth - start) / 0.28);
          p.set(c.x, 0, c.z);
          sc.set(Math.max(s, 1e-4), Math.max(s * c.height, 1e-4), Math.max(s, 1e-4));
          mesh.setMatrixAt(i, m.compose(p, q, sc));
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (dim !== lastDim) {
        lastDim = dim;
        material.color.setScalar(1 - 0.65 * dim);
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
