# SwarmKit City asset kit

Hand-modelled and procedural: every mesh was built with bpy scripts in Blender 5.0.1 (no stock models, no AI-generated media).
Source: `site/art/city-kit.blend` (the generator scripts are embedded in it as text blocks `kitlib.py`, `kitmodels.py`, ...).
Total: 5 GLB files, 2125 triangles, 83 424 bytes (budget 1.5 MB), plus `palette.png` (523 bytes).

## Files

| File | Bytes | Tris | Top-level nodes |
|---|---:|---:|---|
| `buildings.glb` | 40 188 | 1212 | `body_a`, `body_b`, `body_c`, `roof_flat`, `roof_pitched`, `roof_box`, `scaffold`, `annex` |
| `drone.glb` | 15 384 | 426 | `drone` (children: `drone_lane`, `rotor_fl/fr/bl/br`, `hook_cable`, `hook_head`) |
| `depot.glb` | 7 164 | 170 | `depot` (child: `depot_lane`) |
| `props.glb` | 9 896 | 147 | `tree_round`, `tree_cone`, `lamp` |
| `table.glb` | 10 792 | 170 | `table_corner`, `sheet_corner`, `tsquare`, `pencil` |
| `palette.png` | 523 | | the shared palette, for reference |

Every GLB holds one material (`kit_palette`: base colour texture only, metallic 0, roughness 1, single-sided, nearest filtering) and embeds its own copy of the palette PNG.
All modules are at the origin of their file, overlapping, not laid out side by side: fetch by name (`scene.getObjectByName('body_a')`), `clone()`, then set position, rotation and scale. Nothing in any file has a baked scale or translation other than the documented child pivots below.

## Conventions

Metres, +Y up, front faces +Z (yaw 0), origin at the bottom centre of the module's footprint (exceptions: table pieces, see below).
Flat-shaded, chamfer bevels (0.03 to 0.06 m).

## Building modules (`buildings.glb`)

New buildings are a stretched body plus unscaled caps, so the site's `height = lot.height * build` scaling keeps window bands and caps in proportion.

| Node | Authored size (m) | How to use |
|---|---|---|
| `body_a` | 2.52 x 1.00 x 2.52 (frieze and plinth proud to 2.58) | 3 horizontal window bands, lane frieze under the roof |
| `body_b` | same | vertical window slots, lane plinth |
| `body_c` | same | lane corner piers, two wide window bands |
| `roof_flat` | 2.62 x 0.28 x 2.62 | parapet; lane roof deck at y = 0.08, small hatch |
| `roof_pitched` | 2.66 x 0.80 x 2.62 | gable, ridge along X; lane roof planes |
| `roof_box` | 1.67 x 1.00 x 1.12 (x -0.85..0.82, z -0.50..0.62) | rooftop box and water tank, neutral, no lane part; sits on the deck at y = height + 0.08, keep offset within 0.3 m of the roof centre |
| `scaffold` | 2.82 x 1.00 x 2.82 (lane top rail 2.88) | rework cage; lane top rail |
| `annex` | 1.62 x 1.44 x 1.62 (slab top at 1.30, roof vent to 1.44) | low flat-roofed lot; lane roof deck |

- Body: `scale.set(s, h, s)` with `s = footprint / 2.52` (1 at the 70% setback of a 3.6 m lot) and `h = lot.height * build`. Only the vertical edges are chamfered, so non-uniform Y scaling never distorts a bevel. Window bands are proud 0.02 m panels; they just stretch.
- Caps (`roof_flat`, `roof_pitched`): `scale.set(s, 1, s)` (never scale Y), `position.y = h`.
- Scaffold: `scale.set(s, h, s)`, placed on the lot like the body. Poles are 0.07 m square and only stretch in length; the diagonals shear a little at tall scales.
- Annex: `scale.set(s, build, s)` with `s = footprint / 1.5` (annex footprint ~1.51 m); at `build = 1` it is 1.30 m tall, near the engine's `ANNEX_H` 1.28.
- Every `*_lane` child inherits its parent's scale, so lane parts scale with the building.

## Drone crane (`drone.glb`)

Origin at the bottom of the skids (sits on a pad at y = 0). Body span 0.62 m, rotor tip to tip 0.90 m, height 0.33 m to the canopy top. Nose sensor on the front (+Z).

| Node | Pivot | Notes |
|---|---|---|
| `drone` | skid base centre | grey body, legs, arms, nose sensor |
| `drone_lane` | same | canopy and four motor pods (lane tint) |
| `rotor_fl`, `rotor_fr`, `rotor_bl`, `rotor_br` | hub, at y = 0.30, x = -0.3 / +0.3, z = +0.3 (f) / -0.3 (b) | spin about local Y; one shared mesh, 0.30 m crossed blades (24 tris each) |
| `hook_cable` | winch, y = 0.13 | 0.085 m cable hanging down; `scale.y = k` stretches it |
| `hook_head` | cable end | after stretching set `position.y = 0.13 - 0.085 * k`; default is `y = 0.045` (k = 1) |

Park the drone with `hook_cable.scale.y = 0.05` and `hook_head.position.y = 0.126`.

## Depot hangar (`depot.glb`)

One design, used twice. Origin at the centre of the footprint (3.4 m wide in X, 3.6 m deep in Z: hangar body z -1.8..0.4, landing pad z 0.4..1.8), height 2.05 m to the roof ridge, 2.19 m to the beacon. The doors and the pad face +Z, so yaw 0 is the engine's agy depot (at -z); the opencode depot (at +z, facing -z) is `rotation.y = Math.PI`. Parked drones sit on the pad ring at (0, 0.06, 1.1) in depot space (y 0.06 is the pad top).
`depot_lane` holds the roller shutter, the stripe above it, the landing ring and the beacon ball. To leave a lane unused ("dark"), tint with a dim colour or darken the whole material.

## Props

- `props.glb`: `tree_round` (0.8 x 1.25 m), `tree_cone` (0.83 x 1.30 m), `lamp` (0.2 x 1.07 m, lantern uses the `lamp` swatch). No lane parts.
- `table.glb`: the origin sits on the table-top plane (y = 0), not at the bottom, and the piece extends towards +X and +Z.
  - `table_corner` 3.0 x 3.0 m, top at y = 0, wooden lip to y = 0.07, down to y = -0.50. Its top is exactly at y = 0, so lower the site's own table plane below it (about -0.01) or the two will z-fight. For the other three corners rotate by 90 degree steps about Y.
  - `sheet_corner` 2.4 x 2.4 x 0.04 m, pale sheet with a blue border.
  - `tsquare` 3.1 m long, lies flat along X (head at -X). `pencil` 1.62 m long along X.

## Lane colour: one approach (tint nodes)

Every lane-coloured part is its own child node named `<module>_lane` and its faces use the palette swatch `tint` (pure white, `#ffffff`, palette index 13) or `tint_lo` (`#cdcdcd`, index 14, undersides). These nodes are rendered white in the GLB. The site tints them by giving those meshes a copy of the kit material with `color` set to the lane colour (white times colour gives exactly the lane colour; `tint_lo` is a slightly darker shade of it):

```js
const laneMat = kitMat.clone();            // kitMat: the shared kit material
laneMat.color.set('#e69f00');              // agy; '#1aa7a1' for opencode, a grey for the existing city
node.traverse((o) => { if (o.isMesh && o.name.endsWith('_lane')) o.material = laneMat; });
```

Make one `laneMat` per colour, not per instance. `*_lane` nodes: `body_a_lane`, `body_b_lane`, `body_c_lane`, `roof_flat_lane`, `roof_pitched_lane`, `scaffold_lane`, `annex_lane`, `drone_lane`, `depot_lane`. Modules with no lane node (`roof_box`, props, table pieces) use fixed swatches only. The review renders use exactly this approach (white swatch times amber `#e69f00` / teal `#1aa7a1`; the old-city mock uses a warm grey).

## Palette

`palette.png`: 64 x 64, 8 x 8 grid of 8 px swatches, sRGB. Swatch index `i` has its centre at `u = (i % 8 + 0.5) / 8`, `v = 1 - (floor(i / 8) + 0.5) / 8` in glTF UVs, which is pixel `(8 * (i % 8) + 4, 64 - 8 * floor(i / 8) - 4)` from the top left. Rows above index 27 are unused magenta. All UVs are collapsed onto swatch centres, so mipmapping or filtering never bleeds: keep nearest filtering and no mipmaps if you rebuild the texture. Shading comes from the lights; the darker `*_lo` / `*_dk` swatches on plinths and undersides fake a little contact shading, but there is no real baked ambient occlusion in this kit.

| i | name | hex | used for |
|--:|---|---|---|
| 0 | paper_hi | #f9f4e8 | wall tops |
| 1 | paper | #f3ebd9 | walls (token `--paper`) |
| 2 | paper_mid | #e6dcc3 | plinths, belts, door frame (token `--paper-2`) |
| 3 | paper_lo | #d2c6a8 | plinth shade, undersides |
| 4 | paper_dk | #b9ac8c | pencil ferrule |
| 5 | grey_hi | #ddd8cc | roof caps top, depot roof top, roads |
| 6 | grey | #c7c0b1 | roof caps sides, depot roof slopes, drone body |
| 7 | grey_mid | #aaa292 | cap undersides, vents |
| 8 | grey_lo | #8b8576 | pad underside |
| 9 | grey_dk | #6a655b | drone arms |
| 10 | glass | #44556b | windows |
| 11 | glass_hi | #6c7f99 | spare window tone (unused so far) |
| 12 | ink | #0b1b33 | depot opening, rotors, sensors, pencil lead (token `--blueprint-ink`) |
| 13 | **tint** | #ffffff | **lane parts, tinted per lane** |
| 14 | **tint_lo** | #cdcdcd | lane parts, undersides |
| 15 | lamp | #fff1c4 | lantern glass |
| 16 | leaf | #9db382 | tree tops |
| 17 | leaf_dk | #7a9568 | tree undersides |
| 18 | trunk | #8a6b4c | tree trunks |
| 19 | wood | #bb9d72 | table lip, T-square, roof tank lid |
| 20 | wood_dk | #8f7451 | table fascia, T-square head |
| 21 | steel | #9ca5ae | scaffold poles, tank, hook head |
| 22 | steel_dk | #6d757e | rails, braces, legs, cable, lamp post |
| 23 | blueprint | #3d79c6 | sheet border, pencil (token `--blueprint-line`) |
| 24 | sheet_blue | #dce7f4 | blueprint sheet |
| 25 | table_top | #e0d5b9 | table top |
| 26 | pad | #b4ad9e | depot landing pad |
| 27 | spare | #f3ebd9 | reserved |

## Compression and loading

Compressed with `EXT_meshopt_compression` (filter method) plus `KHR_mesh_quantization`: normals 8-bit, UVs 16-bit, **positions stay float32**. Stock `gltf-transform meshopt` also quantizes positions, which bakes a dequantization scale and translation into the node transforms: that breaks the pivots and any scale the site sets (we measured it), so the kit is packed with a custom `@gltf-transform` script (reorder, quantize normals and UVs only, meshopt) run through `npx` from outside the repo. Blender's built-in Draco is unavailable in this install (`libextern_draco.so` missing), so Draco was not used.

The site needs `GLTFLoader` plus the meshopt decoder that ships with three (no new dependency):

```js
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
```

One shared material: load the first GLB, keep `kitMat = gltf.scene.getObjectByName('body_a').material`, and assign it to every mesh of the other files (their `map` is an identical 64 x 64 PNG, so the only cost of not doing this is a few redundant textures). If you load `palette.png` yourself, set `texture.flipY = false`, `colorSpace = SRGBColorSpace`, `NearestFilter`.
