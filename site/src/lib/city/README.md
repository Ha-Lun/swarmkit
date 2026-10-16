# SwarmKit City scene engine

The scene replays `public/data/featured-run.json` (one real run, not a median) as a miniature city. `types.ts` is
the contract; `lots.ts` and `timeline.ts` are pure (plain node runs them; tests in `test/city/`). Visual parts only
see `types.ts`: they get a `LotLayout` once and a `StageState` every frame.

## Coordinates

Metres, ground plane `y = 0`, `+y` up. The blueprint plot is centred on the origin (rows along `z`). The existing
city block, which the lots merge into, sits on the `-x` side across a link road; the annex for extra branches is a
row of small slots past the block's `+z` edge. Lane depots sit off the plot: `agy` at `-z` (facing `+z`),
`opencode` at `+z` (facing `-z`). Yaw 0 faces `+z`. `layout.bounds` frames everything.

## Beats (real run, from `buildTimeline`)

Beats open on event predicates; idle gaps are compressed by `sqrt(seconds)` and every present beat gets at least 6%
of the runway. Recommended runway: `SCROLL_VH` = 900 vh.

| Beat | Opens on | u | Run time (s) |
|---|---|---|---|
| hero | (before the run) | 0.000-0.070 | 0 |
| task | `task` | 0.070-0.141 | 0-2.5 |
| plan | `plan_mode` | 0.141-0.233 | 2.5-20.6 (approved at 11.9) |
| lanes | first `dispatch` | 0.233-0.359 | 20.6-227.4 |
| verify | first verify/review/resume after it | 0.359-0.585 | 227.4-534.9 |
| merge | first `merge` | 0.585-0.660 | 534.9-542 |
| review | first cross-model `review` | 0.660-0.910 | 542-1387 |
| bill | `done` | 0.910-1.000 | 1387-1396 |

Honesty notes the DOM must keep: the lots merge before the cross-model review; the review leads to the small
`review-fixes` annex (dispatched at 1102, merged at 1377). Nothing was recorded between 563 and 1102 s. `cron` failed
its tests and was finished by an agy fixer branch (`cronfix`, shown as rework on cron's lot, not a lot of its own).
Most `ok:false` self-checks were a denied command, not wrong code. Reviews carry no verdict in the data.

## State fields (`StageState`)

`u`, `runTime` (s), `beat` + `beatProgress`, `blueprint` and `split` (0..1), `planApproved`, `planApproval`,
`workers[]` (per original lot: `phase`, `build`, `rework` + `reworkLane`, `resumes`, `scan` + `flag`, `review`,
`selfCheck`, `merge`), `extras[]` (annex lots: `phase`, `build`, `merge`), `activeScan` (`kind`, `target` slug or
null for the whole block, `progress`), `drones[]` (per lane: `used`, `jobs` = lots being built or reworked with their
progress), `mergeAll`, `bill`, `counters` (dispatched, built, merged, reviewsDone, crossReviewsDone, resumes). Units
and edge cases are in the comments in `types.ts`.

## How to write a visual part

Export a factory `createX(layout: LotLayout, palette: CityPalette): CityPart` (`createTiltShift(): TiltShift`).

- `object`: one `THREE.Object3D` root; scene.ts adds it to the scene.
- `update(state, dt)` runs every frame: cheap and allocation-free (no `new`, no array literals, no closures; reuse
  scratch vectors and colours made in the factory). Read only `state` and `dt`; `dt` is for idle motion (bobbing
  drones), never for progress. Same state, same picture: scrolling back must rewind exactly.
- No DOM, no scroll reads, no text in WebGL (labels are DOM, positioned by scene.ts from lot centres), no
  randomness unless seeded from the slug.
- Reduced motion: scene.ts may call `update` only at beat poses; a part must look right for any single state.
- `dispose()` frees every geometry, material and texture you created.
- Placeholder look until the Blender kit lands: flat matte boxes, cones and lines (`MeshLambertMaterial` or
  `LineBasicMaterial`), colours only from `CityPalette` (lane id -> `laneAgy` / `laneOpencode`). Status colours
  (`ok`, `fail`) always come with a shape.

### Acceptance per module

- **blueprint**: plot outline and lot outlines in `palette.line`, drawn on by `blueprint` (0 = nothing, 1 = all
  lines), lots separate from the plot outline by `split`. Annex outlines appear only with an extra's `build > 0`.
- **buildings**: instanced boxes per lot, height `lot.height * build`; `rework` shows as a scaffold or top band
  rising; extras get a different silhouette (low, flat-roofed annex). Position each lot with `lotPoseAt(layout,
  i, merge, out)` from `lots.ts` (the merge module uses the same function, so they stay in sync).
- **drones**: simple cones per lane colour, parked at the depot when `jobs` is empty; per job, fly depot -> lot early
  in `progress`, hover while it rises, home near 1. An unused lane's depot stays dark.
- **scan**: a sweeping ring or beam over `activeScan.target` (over `layout.cityBlock` when the target is null) at
  `progress`. After a scan, `passed` shows a tick-like shape and `flagged` a flag-like shape on the lot; never
  colour alone. Orchestrator and cross-model scans differ in shape too (e.g. ring vs. wide bar).
- **merge**: during `merging`, the lot footprint lifts and slides from `lots[i]` to `block[i]` with `merge`;
  `roads` fade or draw in with `mergeAll`. Use `lotPoseAt` for the lot footprint so it matches the buildings.
- **tiltshift**: a cheap two-pass blur band (horizontal then vertical, strength rising away from a horizontal focus
  band) as post passes via `install(host)`. `setEnabled(false)` skips it entirely; high tier only.
