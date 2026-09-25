# Handoff: SwarmKit showcase site (state at end of session 1)

Read `PLAN.md` (plan), `BRIEF.md` (brief + look), `CLAUDE.md` (rules) first. This file says where things are.

## Where the work lives
- Branch `site/integration`, worktree `/home/ha-lun/opencode-config/.worktrees/site-integration` (HEAD after this commit). **Not merged into `main`.** `main` has Phases 0-4 only (DOM site, no canvas).
- Run: `cd .worktrees/site-integration/site && npm run dev` (0.0.0.0, port 4321 by default; earlier sessions used 4324). Pages: `/` (site), `/lookdev` (material/comet sliders), `/previs` (old grey-box).
- Old worktrees `site-previs`, `site-lookdev`, `site-content` are merged into `main` and can be removed (ask the human first: never remove/merge without an explicit instruction).
- Root of the repo is SwarmKit (`core/` is the source of truth for agents/skills; `scripts/build.py` generates outputs). The site derives all counts from it at build time.

## Phase status (PLAN.md)
- 0 build-log capture: done. Benchmark work DEFERRED (human will supply a benchmark file; `benchmarks.ts` expects `{harness?, model?, rows:[...]}`, a guess; Proof shows "pending" until it exists).
- 1 brief (G1) approved. 2 grey-box previs approved. 3 design system + lookdev (G2) approved. 4 DOM chapters (G4) approved.
- 5 integration: built (canvas + Lenis/GSAP scroll + pinned scenes + label cards + Reference section). Then feedback rounds 4 and 5 (see below).
- 6 QA (G5) and 7 deploy: NOT started. Domain and horology demo link still open (slot says "Link coming").

## Design direction (changed during the session, PLAN/BRIEF updated)
- Animation-first: pinned full-screen scenes, small captions (16px), long content in a Reference section at the end. Text budget ~12% of viewport per scene (currently max 8.5%).
- Honeycomb is a GLOBE: Goldberg sphere GP(5,0) = 252 cells (12 pentagons) + a small round moon GP(2,0) = 42 cells. Camera orbits on scroll (one continuous camera).
- Round 4 (ceramic + glow) was rejected: human dislikes glow. Round 5 (current): flush speckled-stone panels, engraved ring inlays for agents, NO glow anywhere, hard-edged violet comet (head, tail, sparks, scan/ripple rings), continuous camera + damped progress.
- Finale (particle cloud assembling `./install.sh --all`) is the human's favourite: do not degrade it.

## Open items / next session
1. Human said round 5 is "very good, still some work to do". Get per-element verdicts: stone texture and colour (reads olive/cork; rings look like targets), comet (tail kink at stops; rings are violet, could be stone-toned in `rings.ts`), smoothness, moon. Sliders: `/lookdev` cell + packet panels; comet timing in `src/lib/world/motion-config.ts`.
2. Look values in `src/lib/world/config.ts` are UNLOCKED (round 5). Re-lock only after the human's verdict (log in `.buildlog/artdirection.jsonl`).
3. Real-GPU fps for the stone material was never measured (headless is software GL). Ask the human to run `/?sweep=1` on desktop. Desktop-first: phone / medium-tier tuning deferred by the human.
4. Then merge `site/integration` (only when told to), then Phase 6: Lighthouse (mobile) perf>=90, a11y 100, best-practices>=95, SEO 100; zero console errors on every tier; keyboard nav; run `security-auditor`, `code-proofreader`, `/ponytail-review`; `seo-specialist` (meta, OG image rendered from the globe, JSON-LD). Route-replay buttons need to be keyboard-usable (they are focusable now; verify).
5. Phase 7 deploy: Cloudflare Pages via wrangler; needs the domain decision.
6. Known rough edges: fallback tier flip mid-scroll can jump the layout; hive fan-out landings are small at the hive camera; wordmark nearly touches the globe in the intro at 1440 wide; `window.__lcp.push` console errors seen only in the Playwright MCP harness, not the site.

## Checks (run from `site/`)
`npx astro check`, `npm run build`, `node scripts/layout-check.mjs` (sphere layout), `node scripts/smoothness-check.mjs` (camera boundaries), `node scripts/qa-scenes.mjs` (needs `PLAYWRIGHT_CORE` pointing at a playwright-core install; screenshots + text-area ratios). Bundle: ~217 KB gzip JS total (budget 400 KB).

## Process rules the human set
- Plan first for T2/T3 work (plan mode), get approval, then delegate; worktree for heavy work.
- Log gate approvals and decisions in `.buildlog/human.jsonl` and art-direction rounds in `.buildlog/artdirection.jsonl` (the coordinator writes these, not subagents; do not relabel old entries).
- Honesty: never invent metrics; benchmarks only from `public/data/benchmark_metrics.json`; state limits (e.g. headless fps is meaningless).
- Do not merge or remove worktrees without an explicit instruction. Dev servers bind 0.0.0.0.
