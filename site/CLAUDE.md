# SwarmKit site: rules for Claude Code

- Read BRIEF.md before each phase; the approved plan is `~/.claude/plans/i-believe-the-showcase-peppy-hartmanis.md`. Work one phase at a time and stop at gates. `docs/archive/` is history of the old globe site.
- Branch: work happens on `site/city` (worktree `.worktrees/site-city`). Merging to `main` deploys to production. Never merge, and never push to `main`, without the human saying so.
- Static Astro site. No backend, no React. Three.js is vanilla, in one fixed-canvas island.
- All text lives in the DOM. Never render copy in WebGL; labels pinned to 3D are DOM elements.
- One scroll source of truth: GSAP ScrollTrigger writes the shared progress; the scene only reads it. Native scroll, scrubbed. No autoplay, no scroll lock.
- Never hardcode counts, agent lists or pack names. Derive them from `../core/agents` and `../core/skills` at build time.
- Never invent metrics, testimonials or users.
- Benchmarks come only from `public/data/benchmark_metrics.json`, and only cells with n >= 3 completed runs (enforced in code; show min/median/max and losses). The file may be absent: render an honest "pending" state, never placeholder numbers.
- The featured run comes only from `public/data/featured-run.json`, labelled "one real run, not a median". Worker tokens are quota and are never converted to USD.
- Assets: hand-modelled in Blender plus procedural; no AI-generated media. Models live only under `public/models` as glTF with meshopt (or Draco), sharing one palette texture. Stills live under `public/stills`.
- Budgets: JS < 400 KB gz, models <= 1.5 MB total (lazy), LCP < 2.5 s (DOM hero), CLS < 0.05.
- Tiers: high (tilt-shift post), medium, low/fallback (no WebGL, reduced motion, failed fps probe: stills + full DOM content).
- Animate transform and opacity only in the DOM. Every animation (DOM and scene) needs a `prefers-reduced-motion` path.
- Responsive at 1440, 1024, 768 and 390.
- Dev server binds to 0.0.0.0 (`astro dev --host 0.0.0.0`).
- Logging, all under `.buildlog/`: gate approvals to `human.jsonl`, art-direction rounds to `artdirection.jsonl`, and every dispatch to a worker or subagent to `dispatch.jsonl`, with a `lane` field (`agy`, `opencode` or `codex`) when it went to one of those.
