# SwarmKit City showcase: status (started 2026-10-16)

The showcase site is being rebuilt as "SwarmKit City": a scroll-scrubbed miniature-city 3D scene that replays one real `lead-dev-hybrid` run (the city is the codebase). The old honeycomb-globe site is archived in `docs/archive/`. Everything lives on branch `site/city` (worktree `.worktrees/site-city`). Nothing is merged to `main` and nothing is pushed: merging to `main` deploys to production, and the owner said to keep it off production until City is done.

## 2026-10-17
- Blender asset kit approved at gate G2 (c13e3cd) and integrated.
- Art rounds 3-5 done (latest 38a1ffd): drafting table, blueprint sheet, scaffold cage, drone pad, phone drones, warmer light.
- Globe retired: the City is the homepage (428602b). The old globe code is gone.
- Next: Phase 6 quality gate, a release branch, a Vercel preview, then merge to `main` on the owner's OK.

## Where to start
- Read `BRIEF.md` (approved at gate G1 on 2026-10-16, logged in `.buildlog/human.jsonl`) and `CLAUDE.md` (rules).
- Plan: `/home/ha-lun/.claude/plans/i-believe-the-showcase-peppy-hartmanis.md` (outside the repo; the brief mirrors it).
- Resume: `cd /home/ha-lun/opencode-config/.worktrees/site-city/site && npx astro dev --host 0.0.0.0` (node_modules is a symlink to the main checkout's `site/node_modules`; recreate it with `ln -s /home/ha-lun/opencode-config/site/node_modules node_modules` if missing and never commit it).

## Done
- Phase 0: brief, rules, City palette tokens (`src/styles/tokens.css`), old plan/handoff archived. Gate G1 approved.
- Phase 1: data pipeline. `scripts/export-bench.py` (publishes only cells with >= 3 completed runs, voids cells with a failed run) and `scripts/export-run.py` (allowlisted replay timeline of one real run), `scripts/privacy.py`, tests in `scripts/test-export.py`, loaders `src/lib/benchmarks.ts` and `src/lib/run.ts`. Reviewed by security-auditor; hardened.
- Featured run exported to `public/data/featured-run.json`: scaffold case, `lead-dev-hybrid`, opus-5-5, "Run 2 of 2" (run 1 was cut off by an account usage limit), plan approval automatic via a hook, 8 workers on the opencode and agy lanes, 3 cross-model reviews, 9 merges, final tests green, $0.5436, 1396 s.
- Benchmark data in `public/data/benchmark_metrics.json`: 5 published cells, 1 voided, 19 pending.

## Not started
- Phase 2: Blender asset kit (needs the owner's live Blender; glTF + meshopt, <= 1.5 MB, stills for the fallback).
- Phase 3: scene engine (`src/lib/city/*`), Phase 4: DOM sections (`src/components/sections/*`), Phase 5: integration and removal of the globe code, Phase 6: quality gate (release-tester, code-proofreader, cross-model review, Vercel preview).
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
