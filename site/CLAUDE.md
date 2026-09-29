# SwarmKit site — rules for Claude Code

- Read PLAN.md before each phase. Work one phase at a time and stop at gates.
- Static Astro site. No backend, no React. Three.js is vanilla, in one fixed-canvas island.
- Animation first, text small: the world is the centre. Scene text is one or two short lines, small chips and hover/focus label cards; detail lives in the Reference section. On a pinned scene at 1440x810 visible text covers at most about 12% of the viewport and never sits over the centre (label cards and the finale command excepted).
- All text lives in the DOM. Never render copy in WebGL.
- The scene is 100% procedural: no external models, textures, or volume data.
- One scroll source of truth: ScrollTrigger writes the shared state; the world only reads it.
- Never hardcode counts, agent lists, or cell positions. Derive them from ../core/agents and ../core/skills at build time.
- Never invent metrics, testimonials, or users. Benchmarks come only from public/data/benchmark_metrics.json.
- Look work happens on /lookdev first. Approved values are locked in config; don't change them without a new art-direction round.
- Animate transform and opacity only in the DOM. Every animation needs a prefers-reduced-motion path.
- Follow the 5 fluid-motion rules in the premium-frontend-system skill.
- Log gate approvals to .buildlog/human.jsonl and art-direction rounds to .buildlog/artdirection.jsonl.
- Dev server binds to 0.0.0.0 (`astro dev --host 0.0.0.0`).
- public/data/benchmark_metrics.json may be absent. The Proof chapter must then render an honest "benchmarks pending" state, never placeholder numbers.
