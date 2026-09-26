# Handoff: SwarmKit showcase site (state at end of session 2, 2026-09-26)

Read `PLAN.md` (plan), `BRIEF.md` (brief), `CLAUDE.md` (rules) first. This file says where things are. **BRIEF.md section 8 and PLAN.md section 7 still describe the old flat honeycomb and the round-5 look; they are stale until the look is locked (see Open items).**

## Where the work lives
- Branch `site/integration`, worktree `/home/ha-lun/opencode-config/.worktrees/site-integration`. **Not merged into `main`** (`main` has Phases 0-4 only: DOM site, no canvas).
- Dev server: bind to the Tailscale IP, never localhost or 0.0.0.0 (user preference): `cd .worktrees/site-integration/site && npx astro dev --host $(tailscale ip -4) --port 4321`, i.e. `http://100.126.82.90:4321`. Pages: `/` (site), `/lookdev` (material, light, comet, moon sliders), `/previs` (old grey-box). `/?sweep=1` runs the desktop fps sweep; `?tier=medium|fallback` forces a tier.
- Old worktrees `site-previs`, `site-lookdev`, `site-content` are merged into `main` and can be removed. Ask the human first: never merge or remove a worktree without an explicit instruction.
- Root of the repo is SwarmKit (`core/` is the source of truth for agents/skills; `scripts/build.py` generates outputs). The site derives all counts from it at build time.

## Phase status (PLAN.md)
- 0 build-log capture: done. Benchmarks DEFERRED (human supplies `public/data/benchmark_metrics.json` later; Proof and Reference show "pending" until then; `benchmarks.ts` expects `{harness?, model?, rows:[...]}`, a guess).
- 1 brief (G1), 2 grey-box previs, 3 look dev (G2), 4 DOM chapters (G4): approved.
- 5 integration: built, then art-direction rounds 4-10 (below). Look values are UNLOCKED.
- 6 QA (G5) and 7 deploy: NOT started. Domain and horology demo link still open (slot says "Link coming").

## What the site is now (after round 10)
- **Palette LOCKED: iron-blue** (ink #080b10, ink-2 #121824, wax #9aa6b4, wax-dim #46505e, text #d9dee5; accent violet #a98bff, comet only). Space Grotesk + JetBrains Mono.
- **Globe:** Goldberg sphere GP(5,0), 252 cells, plus a small moon GP(2,0), 42 cells, orbited by one continuous scroll camera.
- **Basalt columns:** heights quantised into `look.cell.steps` levels; flat matte tops with pillow gradient, hue drift and fine grain (high tier); dark striated walls.
- **Reactor pistons:** globe filler columns drive out and retract in sequences (`stroke`, `pistonSpeed`, `activity`, `wave`). Moon fillers pump at `moonStroke` (0.3) of that.
- **Agents = towers with polished caps** standing above every rod (core tallest, then t1, domain, gate). Nothing else is polished.
- **Motion:** globe spins slowly (about 210 s a turn) in intro, Proof and finale, and eases home and stops for the hive and fly-over. The moon spins (40 s a turn) and drifts along a small ellipse, parked the same way (`spinWeight()`).
- **Depth:** key-light cast shadows on high tier (custom depth material shares vertex chunks in `cell-vertex.ts`); medium tier gets an ambient-occlusion stand-in from neighbour heights. No glow anywhere (the human rejected it in round 4).
- **Scenes:** fixed (not sticky) and fade-only: text never moves, only opacity. Cells to Proof hex dissolve renders both halves at the live camera pose with post kept on.
- **Reference:** index rail (Install, How it routes, Roster, Extend, Proof, Build log) with scroll-spy, cards, tables and a marked human/agent timeline. Honest "pending" states kept.
- The finale (particle swarm assembling `./install.sh --all`) is the human's favourite: do not degrade it.

## Open items / next session
1. **Waiting on the human's verdicts** for rounds 9-10 (log them in `.buildlog/artdirection.jsonl`): is depth now right, do agents stand out enough, is the globe too bright for the "dark, quiet" mood, is the specular dot on the caps too glinty, how do the moon and piston/spin speeds feel, how does the Reference read at desktop and phone width.
2. **fps on a real desktop GPU never measured** (headless is software GL). Ask the human to run `/?sweep=1` and paste the numbers. Shadow pass (high tier), per-frame matrix updates (globe and moon) and the bump grain are the new costs. Phone and medium-tier tuning is deferred by the human (desktop first).
3. **Two fixes the human was asked about, not yet answered:** (a) idle on the intro for about 90-170 s and the globe spin carries the moon behind the title text (lower `motion.spin.introFrom` or stop the moon riding the globe that far); (b) `RoutingDiagram.astro` clips text in its gate boxes at 1440 wide ("auth, secrets or input handling cha", "read-only context brief"). Use `frontend-specialist` for (b).
4. **When the human says the look is right:** lock the look values in `config.ts`, log it, update BRIEF.md section 8, PLAN.md section 7 and this file to basalt + iron-blue + living globe + towers.
5. **Then, only when told to:** merge `site/integration`, remove the old worktrees, then Phase 6 QA: Lighthouse (mobile) perf >= 90, a11y 100, best-practices >= 95, SEO 100; zero console errors on every tier; keyboard nav; run `security-auditor`, `code-proofreader`, `/ponytail-review`; `seo-specialist` (meta, OG image rendered from the globe, JSON-LD). Then Phase 7 deploy (Cloudflare Pages via wrangler; needs the domain decision).
6. **Known rough edges:** roster cards in the Reference are not keyboard-focusable (static info; make them links only if per-agent targets exist); rod tint stays at its resting terrain value while a rod is driven out; a tier switch resets the moon to home for one frame; `/lookdev` shadow frustum is sized once at load, so raising `moonDrift` above its initial value there can clip it; a real-GPU shimmer check of the shadow while the key light sweeps is outstanding; `window.__lcp.push` console errors appear only in the Playwright MCP harness, not the site; the Astro dev-toolbar 504 in the console is known dev noise.

## Checks (run from `site/`)
`npx astro check`, `npm run build` (JS about 225 KB gzip, budget 400 KB), `node scripts/layout-check.mjs` (sphere, heights, towers, moon pose), `node scripts/smoothness-check.mjs` (camera boundaries), `node scripts/qa-scenes.mjs` (needs `PLAYWRIGHT_CORE=/home/ha-lun/projects/clavis/node_modules/playwright-core`; screenshots and text-area ratios). Screenshot folders `.integration-shots/` are gitignored.

## Art-direction history (details in `.buildlog/artdirection.jsonl`)
R4 ceramic + glow (rejected: glow) > R5 speckled stone, comet (very good, not locked) > R6 rock terrain, fade-only text, seamless dissolve, polished facets (unsure about rock and colour) > R7 basalt columns + palette candidates (iron-blue chosen) > R8 pistons + spin (better, still flat, agents left out) > R9 towers, shading, shadows (moon static, Reference unstructured) > R10 moon motion + Reference rebuild (awaiting verdict).

## Process rules the human set
- Plan first for T2/T3 work (plan mode), get approval, then delegate; worktree for heavy work.
- The coordinator (main agent) writes `.buildlog/human.jsonl` and `.buildlog/artdirection.jsonl`, not subagents; do not relabel old entries.
- Honesty: never invent metrics; benchmarks only from `public/data/benchmark_metrics.json`; state limits (headless fps is meaningless). No AI-generated media: the human considered an AI image for texture and decided against it.
- Do not merge or remove worktrees without an explicit instruction. Dev servers bind to the Tailscale IP.
