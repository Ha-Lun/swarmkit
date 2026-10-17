// SwarmKit City drafting table: the kit's table pieces under the diorama. A tan slab (palette `table_top`, wooden
// fascia) a margin outside layout.bounds, the kit's `table_corner` lips at its four corners, the pale-blue blueprint
// sheet (palette `sheet_blue`) under the plot, and the T-square and pencil lying on the near margin. Static: nothing
// here depends on StageState, so update is a no-op and the picture is the same for any state. Kit only: with no kit
// the scene keeps its plain paper plane and grid.
//
// Slab and sheet are boxes whose UVs are collapsed onto palette swatch centres (see public/models/README.md), so they
// use the shared kit material and stay in the kit's palette. The kit pieces are cloned from the shared templates and
// share their geometry and material: this part owns only the two box geometries.
import { BoxGeometry, Group, Mesh, Object3D } from 'three';
import type { BufferGeometry } from 'three';
import type { Kit } from './kit.ts';
import type { CityPalette, CityPart, LotLayout, Rect } from './types.ts';

/** Table margin outside `layout.bounds` (m): the trees (2.4 m out) stand on the table. */
export const TABLE_MARGIN = 3.4;
/** Blueprint sheet margin outside the plot outline (m). */
export const SHEET_MARGIN = 0.5;
/** Table slab: top plane (just under y = 0, so the corner pieces' top at exactly y = 0 never z-fights) and fascia depth. */
export const SLAB_TOP = -0.012;
export const SLAB_DEPTH = 0.5;
/** Blueprint sheet: top plane, above the slab and under the plot lines (y = 0.05). */
export const SHEET_TOP = 0.02;
/** Table pieces are 3.0 m corners; the slab must be at least this big in both directions. */
const CORNER = 3.0;

/** Palette swatch indices (public/models/README.md). */
const SW_PAPER_LO = 3;
const SW_WOOD = 19;
const SW_WOOD_DK = 20;
const SW_SHEET_BLUE = 24;
const SW_TABLE_TOP = 25;

/** The table rectangle: `bounds` grown by `margin` on every side. */
export function tableRect(bounds: Rect, margin: number = TABLE_MARGIN): Rect {
  return { x: bounds.x, z: bounds.z, w: Math.max(CORNER, bounds.w + 2 * margin), d: Math.max(CORNER, bounds.d + 2 * margin) };
}

export interface CornerPlacement {
  x: number;
  z: number;
  /** Yaw (rad), a multiple of 90 degrees: the piece extends +x, +z at yaw 0, so each corner turns it inwards. */
  yaw: number;
}

/** The four `table_corner` placements of a table rectangle, in 90 degree steps (min-x/min-z first, then clockwise from above). */
export function tableCornerPlacements(rect: Rect): CornerPlacement[] {
  const x0 = rect.x - rect.w / 2;
  const x1 = rect.x + rect.w / 2;
  const z0 = rect.z - rect.d / 2;
  const z1 = rect.z + rect.d / 2;
  return [
    { x: x0, z: z0, yaw: 0 },
    { x: x1, z: z0, yaw: -Math.PI / 2 },
    { x: x1, z: z1, yaw: Math.PI },
    { x: x0, z: z1, yaw: Math.PI / 2 },
  ];
}

/** Point every vertex of a box face at the centre of one palette swatch (glTF UVs, v up). */
function paintFace(geo: BoxGeometry, face: number, swatch: number): void {
  const uv = geo.getAttribute('uv');
  const u = ((swatch % 8) + 0.5) / 8;
  const v = 1 - (Math.floor(swatch / 8) + 0.5) / 8;
  for (let k = 0; k < 4; k++) uv.setXY(face * 4 + k, u, v);
  uv.needsUpdate = true;
}

/** A box with its top, sides and underside painted from the palette (BoxGeometry face order: +x, -x, +y, -y, +z, -z). */
function paintedBox(w: number, h: number, d: number, top: number, side: number, bottom: number): BoxGeometry {
  const geo = new BoxGeometry(w, h, d);
  for (let f = 0; f < 6; f++) paintFace(geo, f, f === 2 ? top : f === 3 ? bottom : side);
  return geo;
}

export function createTable(layout: LotLayout, palette: CityPalette, kit: Kit): CityPart {
  void palette;
  const root = new Group();
  root.name = 'table';
  const geometries: BufferGeometry[] = [];

  // The slab: top at SLAB_TOP, fascia down to SLAB_TOP - SLAB_DEPTH.
  const rect = tableRect(layout.bounds);
  const slabGeo = paintedBox(rect.w, SLAB_DEPTH, rect.d, SW_TABLE_TOP, SW_WOOD_DK, SW_WOOD_DK);
  geometries.push(slabGeo);
  const slab = new Mesh(slabGeo, kit.material);
  slab.name = 'table-slab';
  slab.position.set(rect.x, SLAB_TOP - SLAB_DEPTH / 2, rect.z);
  root.add(slab);

  // The kit's corner lips.
  const cornerTpl = kit.templates.get('table_corner');
  if (cornerTpl) {
    for (const c of tableCornerPlacements(rect)) {
      const corner = cornerTpl.clone(true);
      corner.position.set(c.x, 0, c.z);
      corner.rotation.y = c.yaw;
      root.add(corner);
    }
  }

  // The blueprint sheet under the plot, a little larger than its outline, above the slab and under the lines.
  const sheetH = SHEET_TOP - SLAB_TOP + 0.01;
  const sheetGeo = paintedBox(layout.plot.w + 2 * SHEET_MARGIN, sheetH, layout.plot.d + 2 * SHEET_MARGIN, SW_SHEET_BLUE, SW_PAPER_LO, SW_PAPER_LO);
  geometries.push(sheetGeo);
  const sheet = new Mesh(sheetGeo, kit.material);
  sheet.name = 'table-sheet';
  // A receiver only: its own shadow on its top face would show as acne (scene.ts honours this flag).
  sheet.userData.noShadowCast = true;
  sheet.position.set(layout.plot.x, SHEET_TOP - sheetH / 2, layout.plot.z);
  root.add(sheet);

  // T-square and pencil on the near (+z) margin, past the lane depot: clones sharing the kit's geometry.
  const nearZ = rect.z + rect.d / 2 - CORNER * 0.55;
  const tsq = kit.templates.get('tsquare');
  if (tsq) {
    const o: Object3D = tsq.clone(true);
    o.position.set(rect.x - rect.w * 0.18, SLAB_TOP, nearZ);
    root.add(o);
  }
  const pen = kit.templates.get('pencil');
  if (pen) {
    const o: Object3D = pen.clone(true);
    o.position.set(rect.x - rect.w * 0.18 + 0.6, SLAB_TOP, nearZ + 0.7);
    o.rotation.y = 0.12;
    root.add(o);
  }

  let disposed = false;
  return {
    object: root,
    update(): void {},
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.clear();
      for (const g of geometries) g.dispose();
    },
  };
}
