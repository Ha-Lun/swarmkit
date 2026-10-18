# SwarmKit City showcase: status (started 2026-10-16)

The showcase site is being rebuilt as "SwarmKit City": a scroll-scrubbed miniature-city 3D scene that replays one real `lead-dev-hybrid` run (the city is the codebase). The old honeycomb-globe site is archived in `docs/archive/`. Everything lives in `site/` on `main`; the feature branch and worktree were merged and deleted. It is released: deployed to production (main bc0170f, https://swarmkit-site.vercel.app).

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
- Work happens on `main` (or a short-lived branch from `main`). The site is in `site/`.
- Every push to `main` deploys production via Vercel (project swarmkit-site, root directory `site`).
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

## Related branches (all local, unmerged, unpushed)
- `bench/showcase`: `--showcase` flag in `bench/compare.py` and `bench/plan_approver.py` (how the plan-first run was recorded).
- `swarm/cut-lead-dev-codex-task`: removes the `lead-dev` agent and the whole Codex target; `lead-dev-hybrid` becomes the single orchestrator. Recovery tag: `archive/lead-dev-and-codex-task`; restore steps in `CHANGELOG.md` on that branch.
- Local `main` is 7 commits ahead of `origin/main`, none pushed: the 4 bench cost / `agy-task` worktree fixes from this session plus 3 earlier commits (hybrid-build workflow, scaffold bench case, steer fix for lead-dev-hybrid).
- The site on `main` is the old globe site; it still lists `lead-dev` and will go stale once the cut merges.

## Merging to production later
Merging to `main` deploys to production (Vercel). The Vercel setup and the merge checklist are in `docs/archive/HANDOFF.md` (they were in `site/HANDOFF.md` before this branch moved it); the Vercel project is swarmkit-site with root directory `site`. Before merging site/city, also decide what to do about the unmerged branches above and push them in a deliberate order; the owner must say when.
