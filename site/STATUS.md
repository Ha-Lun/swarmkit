# SwarmKit City showcase: status (started 2026-10-16)

The showcase site is being rebuilt as "SwarmKit City": a scroll-scrubbed miniature-city 3D scene that replays one real `lead-dev-hybrid` run (the city is the codebase). The old honeycomb-globe site is archived in `docs/archive/`. The site was removed from `main` on 2026-10-18 (commit 206bf6f) and lives on branch `showcase`, where Vercel deploys production (https://swarmkit-site.vercel.app). The City was released on 2026-10-17 (main bc0170f); the Galaxy replaced it on 2026-10-20.

## 2026-10-21 (galaxy round H, branch site/nebula)
- Owner feedback: open on a nebula, explode into a galaxy at the merge, orbits less flat. Work on branch `site/nebula` (worktree `.worktrees/site-nebula`), not yet merged into `showcase`.
- Nebula opening: the comet dives into the nebula's knot, which ignites the sun. Orbits: tilted, depth-shaded, lane-coloured trails, dust belts. Merge: supernova burst and shock ring; the debris forms the spiral galaxy. Merge copy now ends "Everything lands as one."
- Checks: tests 17/17, astro check clean, build OK, homepage JS 225 KB gz; hero buttons click-tested at 390 and 1440.
- Follow-ups: owner review (art-direction round 43); real-phone fps; per-frame allocations in the belt drift (tilt() per point); burst timing constants are split between scene.ts and path.ts.
- Round I (same day, owner review): the nebula is now a ray-marched volume (no sprites); ignition clears a dark bubble and the system sits in the nebula remnant; the Milky-Way band (`backdrop.ts`) is gone; the verify step is a wave that lights the rings one by one; rings are continuous. Art-direction round 44 pending the owner's check.
- Follow-up: measure the volume pass on a real phone (high/medium re-march every frame because of the idle drift; low tier and reduced motion only on change); ignition/cavity timing constants are duplicated between scene.ts and path.ts.

## 2026-10-20 (galaxy released)
- The Galaxy replaces the City as the homepage (branch `site/galaxy` merged into `showcase`).
- Round F: procedural photoreal sun, gas/ice-giant planets and 3D ringlets, a smoother two-armed galaxy, no streak particles or grain.
- Round G (alive pass): ambient idle motion (owner-approved 2026-10-20; off under reduced motion), a procedural Milky-Way/nebula backdrop (`src/lib/galaxy/backdrop.ts`), orbit light trails, sun glow and halo, fake depth of field in the close-up.
- Follow-ups: real-phone fps unmeasured; final galaxy sparse on the low tier (390 px); storytelling round pending; the hero "Install" anchor scroll (`#install`) to be checked.

## 2026-10-17 (released)
- City is live on production as the homepage (main bc0170f). The globe is retired.
- Follow-ups: (1) the no-WebGL path logs 3 console errors and downloads the GLB models before falling back to stills; load the kit only after a WebGL context succeeds. (2) The frozen benchmark (Track C) is still pending for more Numbers cells.

## 2026-10-17
- Blender asset kit approved at gate G2 (c13e3cd) and integrated.
- Art rounds 3-5 done (latest 38a1ffd): drafting table, blueprint sheet, scaffold cage, drone pad, phone drones, warmer light.
- Globe retired: the City is the homepage (428602b). The old globe code is gone.
- Done (released 2026-10-17): Phase 6 quality gate, release branch `release/city`, the Vercel preview, and the merge to `main` on the owner's OK.

## Where to start
- Read `BRIEF.md` (approved at gate G1 on 2026-10-16, logged in `.buildlog/human.jsonl`) and `CLAUDE.md` (rules).
- Plan: `/home/ha-lun/.claude/plans/i-believe-the-showcase-peppy-hartmanis.md` (outside the repo; the brief mirrors it).
- Work happens on short-lived branches from `showcase` (e.g. `site/galaxy`, worktree `.worktrees/site-galaxy`). The site is in `site/`.
- Vercel (project swarmkit-site, root directory `site`) deploys production from `showcase`. Push only on the owner's word.
- Dev: `cd site && npm install && npm run dev` (binds 0.0.0.0; report it at http://100.126.82.90:<port>, the Tailscale IP).
- Checks: `npm test`, `npx astro check`, `npm run build`.
- Rules: read `site/CLAUDE.md`.

## Done
- Phase 0: brief, rules, City palette tokens (`src/styles/tokens.css`), old plan/handoff archived. Gate G1 approved.
- Phase 1: data pipeline. `scripts/export-bench.py` (publishes only cells with >= 3 completed runs, voids cells with a failed run) and `scripts/export-run.py` (allowlisted replay timeline of one real run), `scripts/privacy.py`, tests in `scripts/test-export.py`, loaders `src/lib/benchmarks.ts` and `src/lib/run.ts`. Reviewed by security-auditor; hardened.
- Featured run exported to `public/data/featured-run.json`: scaffold case, `lead-dev-hybrid`, opus-5-5, "Run 2 of 2" (run 1 was cut off by an account usage limit), plan approval automatic via a hook, 8 workers on the opencode and agy lanes, 3 cross-model reviews, 9 merges, final tests green, $0.5436, 1396 s.
- Benchmark data in `public/data/benchmark_metrics.json`: 5 published cells, 1 voided, 19 pending.

## Released (Phases 2-6 done)
- Phase 2: Blender asset kit approved at gate G2 (c13e3cd) and integrated (71d139e).
- Phases 3-5: scene engine, DOM sections, integration and removal of the globe code (428602b).
- Phase 6: quality gate passed; release branch `release/city` merged to `main` (bc0170f).

## Follow-ups
- No-WebGL path: 3 console errors, and the GLB models download before the still fallback. Load the kit only after a WebGL context succeeds. In progress (2026-10-18) on branch `fix/nogl-kit` (worktree `.worktrees/nogl`).
- Frozen benchmark (Track C): more Numbers cells still pending.
- Leftovers: Per-lane dispatch logging for the Build log section is not wired yet.

## Wording the site must get right
- Workers flagged `ok=false` are mostly "a command was denied", not wrong code; `cron` genuinely failed its tests and was fixed by an agy fixer branch (`cronfix`).
- The replay shows one real run, not a median. Worker tokens are quota, never converted to USD.
- Early bench costs were undercounted (first result segment only); corrected in `bench/FINDINGS.md` on `main`.

## Related branches (merged into `main` on 2026-10-17, then deleted)
- `site/city`, `release/city`, `swarm/cut-lead-dev-codex-task`, `swarm/worker-guard`, `bench/showcase`, `bench/worker-models`, `fix/bench-cost`.
- Recovery tags kept: `city-started-2026-10-16` and `archive/lead-dev-and-codex-task` (restore steps in `CHANGELOG.md` on that tag).

## Deploying
Vercel (project swarmkit-site, root directory `site`) deploys production from `showcase`; the site is no longer on `main`. Push only on the owner's word.
