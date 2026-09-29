# Handoff: SwarmKit showcase site (session 3 addendum first, then session 2 state below; 2026-09-28)

## Session 4 (2026-09-29): the walk on the globe (branch `site/walk`, NOT merged)
Worktree `/home/ha-lun/opencode-config/.worktrees/site-walk`, branched from `site/integration` at `1d7ef72`. `node_modules` there is a symlink to the integration worktree's (excluded locally through `.git/info/exclude`, not committed). Dev server: `cd .worktrees/site-walk/site && npx astro dev --force --host $(tailscale ip -4) --port 4321` (use `--force` after touching shared modules: Vite otherwise serves a 504 "Outdated Optimize Dep" for gsap and the main page silently drops to the static fallback).

**What it is.** The Cells fly-over is replaced by a walk: the spline camera dives to the surface (up = local surface normal, quaternion orientation), walks a street of ordinary cells between the agent towers in routing order (lead-dev, explore, git-specialist, junior-dev, 19 domain specialists nearest-neighbour, 4 gates), then rises back onto the spline before the Cells to Proof dissolve. The street is a Dijkstra path over non-tower cells that prefers flat ground, rounded with Catmull-Rom; its tiles are lit (panel tone state, palette only). The tower ahead shows a card: name, tier, band, its frontmatter description (up to ~230 chars, `lib/blurb.ts`) and tools. Hover still wins over the walk card, then keyboard focus (focus shows the card but never moves the walker's camera).
- `lib/world/walk.ts` (pure): route, ground envelope (never below the column tops under the camera), heading, `walkCameraPose` (what the world calls and what `smoothness-check` samples), `blendOrientation`/`walkBlendBase`, `nearestTowerAhead`, `visibleOverGlobe`, `horizonFog`.
- One walk weight `walkWeight(chapter, p)` (motion-config, modelled on `spinWeight`) of the DAMPED progress (`camera-path.ts progressOfG(g)` reads chapter progress back from g) drives: position (direction slerp plus distance lerp, a straight lerp would cut through the globe), orientation, FOV 40 to 75, near 0.1 to 0.03, pistons at rest (`honeycomb.update(..., walk)`), walker-frame lights (`studio.update({frame})`), fog from the horizon distance, seam-glow dimming (`comb.setCoreScale`), comet and rings hidden, pixel ratio capped at 1.5 while on the ground (`WALK_DPR`).
- Knobs (all provisional, `motion-config.ts`): `runway.cells` 800 (layout), `mapRunway` (the lengths the camera's speed profile is solved for, 300 for Cells: this keeps intro, hive, Proof and finale camera behaviour EXACTLY as on integration; Cells progress is warped onto its design length in `camera-path.ts`, rate 1 at both ends), `walkRamp` (dive p 0.06 to 0.2, rise 0.8 to 0.9), `walkCfg` (eye 0.3, FOV 75, pitch 15, near 0.03, route span p 0.2 to 0.82, glow dim 0.9, fog 0.5/1.6), `walkScroll` 0.3 (wheel and touchpad multiplier while Cells is on screen, `scroll.ts`), in `walk.ts`: `HEADING_SIGMA` 10, `DWELL` 4/6, `FLAT_COST`.
- Bench: `/lookdev?view=walk` (sliders for eye, FOV, pitch, speed, near, fog, path tiles, tower cards; toggles for the Phase 2 fixes: `?fx=radial,core,fog,light,shadow,comet`, `nopistons`; `?clean=1`, `?eye= &fov= &pitch= &u= &speed= &near= &cards=0 &post=0 &park=1`; `window.__bench` for QA).
- Not graduated into the story (still bench toggles): radial walls (`uRadial`, art direction) and the texel-snapped tight shadow frustum (`studio.fitShadow`).

**Bugs found on the way (fixed).** Grain-bump `normalize(0)` made one NaN pixel that bloom and GTAO spread over the whole frame (high tier went black with the ground filling the view): guarded in `cell-material.ts`. The dive's quaternion slerp flipped where the spline and walker orientations are 172 degrees apart: now a blend of rotation vectors about a base orientation. Lengthening Cells re-solved the shared scroll-to-camera profile and moved the hive camera by up to 0.4 globe radii: fixed with `mapRunway` plus the Cells warp.

**Verified (run).** `scripts/smoothness-check.mjs` now also samples the blended story camera across Cells (+-60vh): position, orientation and FOV steps, second-difference spikes, weight at both ends, up = surface normal at full weight; all pass, and the four chapter boundaries pass in layout vh. Camera pose at the same chapter and progress is identical to `site/integration` (0.0000 units) for intro, hive, Proof and finale, both by module (node, 4 chapters x 201 points) and on the two live dev servers (6 positions). `git diff site/integration` is empty for `chapters/{intro,hive,proof,finale}.ts`, `swarm-particles.ts`, `transitions.ts`. `astro check` 0 errors, `npm run build` ok, `layout-check` ok.
**fps (real GPU: NVIDIA GTX 970M, 2015 laptop, headless Chrome, rAF capped at 60).** 1440x810 pixel ratio 1: high 60/60/60 and medium 60/60/60 (dive/walk/rise, mean). High at pixel ratio 2 (2880x1620): without the cap the walk fell to mean 39.5, median 30; with `WALK_DPR` 1.5 the walk holds 59.9, but the two resizes cost a hitch (dive worst frame 117 ms, rise 233 ms, rise mean 51.9). Medium never dropped. 60 is the vsync cap, so headroom is unknown. Recipe for a GPU headless run: `EGL_PLATFORM=surfaceless __EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/10_nvidia.json` and `--headless=new --use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist` (the default falls back to llvmpipe/SwiftShader).

**Open / for the human.**
1. Look: the ground view is dark (walls near-black even with walker-frame lights), a bright glare sits on the tile tops, the grain bump sparkles up close, medium tier walls go bright and flat with the walker's lights (no shadow/AO). Round 12 (walk) is opened in `.buildlog/artdirection.jsonl`, no verdict.
2. The 2x-to-1.5x pixel-ratio swap hitches at the two transitions; the alternative is a permanent 1.5 cap on the high tier.
3. Pace: runway 800vh, wheel x0.3. The human said the walk was "way too fast" at 300vh and still fast at 800; not confirmed after the x0.3 change. Lower `walkScroll` or lengthen `runway.cells` (one number; `mapRunway` stays).
4. The first street swings well around the core (the ring next to lead-dev is blocked by the three t1 towers), so lead-dev to explore is a detour.
5. Cards clamp to the top of the screen (over the nav) when the tower top is above the frame; a leader line is not built. Not tested at other window sizes or in a real browser session with a pointer.
6. `/?sweep=1` in the older notes does not exist on the main page (only `/lookdev?sweep=1`).
7. Everything from session 3 still stands (rounds 9 to 11 verdicts, Vercel production branch, phase 6 QA and 7 deploy not started).


## Session 3 (2026-09-28): round 11 built, first Vercel deploy
- **Round 11 (human's full brief, overrides round 4 "no glow" and rounds 7-8 "matte basalt")**: MeshPhysicalMaterial metal (metalness 0.7, roughness 0.35, clearcoat), per-tile roughness/tint jitter, sphere gradient, fill light + raised rim, ACES + sRGB, procedural env on both tiers, emissive core in the globe's seam floor, GTAO + bloom + vignette on the high tier (`post.ts`, `cell-normal.ts` G-buffer), radial-gradient background + `look.bg.fog`. All tunables in `config.ts` (`cell.metalness`..., `light.fill`, `core.*`, `bg.*`, `post.*`) and `/lookdev` sliders. Logged as round 11 "opened" in `.buildlog/artdirection.jsonl`; **no human verdict yet**.
- Checks green: `astro check` 0 errors, `npm run build` (~223 KB gz JS), `layout-check`, `smoothness-check`.
- **Not verified visually**: headless Chromium (SwiftShader) lost its WebGL context after repeated heavy renders, so only `/lookdev` wide + moon views were captured (before a real bug fix). After that, `capEnvOf` in `cell-material.ts` was rescaled (`1 + 24*capGloss` -> `1 + 3*capGloss`, it was tuned for envIntensity 0.07 and blew the polished caps out at envIntensity 1.0). The fix is **not re-checked visually**; `/lookdev?view=cell` (the close-up on the core cap) is the view to look at first. The main site `/` also never showed a canvas in headless because the fps probe (pre-existing) drops to the no-canvas fallback below 30 fps. `qa-scenes.mjs` not run. Look at it on a real GPU/browser.
- Commit history caveat: the 5 round-11 feature commits are not individually buildable (early commits read `config.ts` fields that only land in the last one, `3a37440`). Only the branch tip is verified. Squash on merge or accept.
- Dev server left running on `http://100.126.82.90:4321` from the worktree (pid may be stale; check `lsof -ti:4321`).

### Vercel (set up 2026-09-28, read before merging to main)
- Project **`swarmkit-site`**, id `prj_3m5XNrUe8f7xzgMHW8sguHairoga`, owner `ha-lun` (personal account, scope `ha-luns-projects`, id `team_AOvtkYp0gGtendziNWA1owwJ`). Linked to GitHub `Ha-Lun/swarmkit`, framework `astro`, **Root Directory = `site`**, **"Include source files outside the Root Directory" = on**. The second one is required: `site/src/lib/agents.ts` reads `../core/agents` (and `../core/skills`) at build time, so the build breaks without it.
- Why it was made through the API: the dashboard's Root Directory picker browses the default branch (`main`), which has no `site/` yet, so it could not find it. The project was created with the Vercel MCP tools (`create_project` + `update_project` with `rootDirectory` and `sourceFilesOutsideRootDirectory`).
- First deploy `dpl_5zDXUa8HgGMWHo68VxaLbTmF3t7J` was triggered by hand (`create_deployment`, `target: production`, `gitSource` ref `site/integration`, commit `62fc3a2`). Built READY in ~20 s. Live at `https://swarmkit-site.vercel.app` (also `swarmkit-site-ha-luns-projects.vercel.app`, branch alias `swarmkit-site-git-site-integration-ha-luns-projects.vercel.app`).
- **Production Branch was NOT changed** (the MCP tools expose no field for it). It is most likely still `main`, so a push to `site/integration` should give a *preview* deploy, not a production one, and `swarmkit-site.vercel.app` stays on that one manual production deploy until `main` moves or it is redeployed by hand. **Verify in the dashboard (Settings -> Git -> Production Branch).**
- **When merging `site/integration` into `main`** (only when the human says so; plan: PR after look lock + phase 6 QA):
  1. Nothing needs re-pointing: Root Directory and the outside-root setting are already stored on the project, and once `main` has `site/` the dashboard picker works too. The merge push to `main` triggers the production deploy.
  2. Every push to `main` builds this project, including pushes that only touch `core/`, `claude/`, `scripts/`. That is partly wanted (agent/skill counts on the site come from `../core`), but it is noisy. Options: leave it, set an Ignored Build Step, or enable "affected projects".
  3. Keep `site/` self-contained: `package.json` + lockfile in `site/` (they are). Do not move `core/` or rename `../core/agents` without updating `agents.ts` and this note.
  4. If a Production Branch was set to `site/integration` in the dashboard, switch it back to `main` at merge time, then delete the stale branch alias.
  5. Deployment Protection reported `ssoProtection: all_except_custom_domains` on creation; a plain `curl` on the production URL returned 200, but check the page in a private window and decide whether the site should be public.
  6. No custom domain, and `astro.config.mjs` has no `site`. The swarm rule (seo-worker gate) needs a real `production_url` before the public deploy: ask, never guess. Phase 6 (QA) and phase 7 (deploy) in PLAN.md have not run.

### Tomorrow
1. Look at round 11 on a real browser (`/lookdev`, all views incl. `cell`, both tiers) and give the verdict; then tune (env richness, bloom threshold, core intensity, `capGloss`, walls not too black) and log it in `.buildlog/artdirection.jsonl`.
2. Real-desktop `/?sweep=1` fps numbers (GTAO + bloom + G-buffer are new costs).
3. Check the Vercel Production Branch and the public/protected state of the live URL.
4. Still open from session 2: rounds 9-10 verdicts, moon-behind-title fix, `RoutingDiagram.astro` text clipping at 1440 px, then lock the look, update BRIEF 8 / PLAN 7, PR to `main`, phase 6 QA, domain decision, phase 7.

---

# Session 2 state (2026-09-26)

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
