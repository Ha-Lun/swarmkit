# SwarmKit Showcase Site: Brief ("SwarmKit City")

**Gate G1: pending human approval.** Nothing past Phase 0 starts until the human approves this brief and the look in section 8. The approved implementation plan is `/home/ha-lun/.claude/plans/i-believe-the-showcase-peppy-hartmanis.md`; if this brief and the plan disagree, the plan wins and this file gets corrected. The previous globe site (honeycomb, comet, autoplay film) is history: `docs/archive/PLAN.md` and `docs/archive/HANDOFF.md`.

## 1. Goal

One site, two jobs.

1. **Explain SwarmKit.** A developer understands what it is, which mode to use when, how the config reaches three CLIs, and how to install it in under 90 seconds.
2. **Prove SwarmKit.** One real `lead-dev-hybrid` run is acted out in 3D, with its real numbers, and the site shows that the swarm built it.

Story, in one line: **Opus plans. Cheaper models build, in parallel. One config, three CLIs.**

Core idea: a tilt-shift miniature-city diorama on a drafting table. **The city is the codebase.** The run builds new lots into it. The part that impresses and the part that explains are the same thing.

## 2. Audience and tone

- **Audience:** developers evaluating agent setups (Claude Code, OpenCode, Antigravity). They read docs, distrust hype, and will check numbers.
- **Tone:** precise, confident, no hype. Short declarative sentences. Say what it does and what it costs. No superlatives, no "revolutionary", no crypto/luxury register.
- **Copy rule:** all copy lives in the DOM. Nothing is rendered as text in WebGL (labels pinned to 3D objects are DOM elements positioned from the projected point). During the pinned run, text stays at the edges and short; below the run the page is normal readable sections.
- **Derived facts only:** agent, skill, pack, MCP server and slash command counts and the roster are computed at build time from `../core/agents` and `../core/skills`. Nothing is hardcoded and nothing is invented.

## 3. Non-goals

- No testimonials, logo farms, user counts, or star counts. No invented metrics.
- No text in WebGL.
- No AI-generated media (images, models, textures, video).
- No backend; static site only. No React.
- No sound in v1.
- No autoplay film and no scroll lock. The visitor scrolls; the scene follows.

## 4. Honesty rules (non-negotiable)

- **Benchmarks only from data.** `public/data/benchmark_metrics.json` is the only source. It may be absent: then the Numbers section renders an honest "pending" state. No placeholder or illustrative numbers, ever.
- **n >= 3 gate, enforced in code.** Only cells (fixture x agent type) with at least 3 completed runs are published. A cell with fewer is excluded, and a failed run voids its cell. Each published cell shows min / median / max, never a bare mean or a single run.
- **Losses stay visible.** Where SwarmKit is slower or costs more (for example hybrid wall time against stock), the cell says so, in the same size as the wins.
- **Harness and model are disclosed from the data file** (`model_usage`), per number. The scaffold data was recorded with `claude-sonnet-5-5`; the site states exactly that, never "Opus" for a measured result. When there is no data, the disclosure reads "pending".
- **The featured run is one run.** The replay (lots, order, costs, tokens, wall time, verify result) comes only from `public/data/featured-run.json` and is labelled **"one real run, not a median"**. The Numbers section carries the statistics.
- **Worker tokens are quota, never USD.** agy and opencode tokens are shown as tokens or as share of a quota. They are never converted to dollars. Only the Claude side shows USD, with the stock run beside it.
- **Allowlisted run export.** `featured-run.json` holds only task title, workers `{slug, lane, ok, tokens, deniedCount}`, event order, cost, wall time and verify result. No paths, commands or code.
- **Asset claim:** "hand-modelled in Blender plus procedural, no AI-generated media". If that changes, the claim changes with it.
- **Build log:** separate what agents did from what the human did (gate approvals, art-direction rounds, manual edits). Show the human-intervention count. The headline reads "built by lead-dev-hybrid: N opencode tasks, M agy tasks, K Claude subagents, H human interventions", every number from `.buildlog/*.jsonl`.

## 5. Concept: what the diorama is

| Object | Means |
|---|---|
| The city, its blocks and roads | The codebase |
| An empty blueprint plot beside the city | The task |
| Lots on the plot, each with a worker slug | The file-disjoint parts of the approved plan |
| A hangar per lane (agy, opencode); unused lanes stay dark | A vendor lane; which CLIs the run really used |
| Drone cranes and rising buildings | Workers building in parallel; height and build time scale with real tokens and order |
| Scan beam over each building | Verify (tests re-run) plus cross-model review |
| Flag on a building, a crane returns | A real `ok:false` worker: resumed, or Opus finishes it |
| Lots lifting into the block, roads joining | Merge |

## 6. Chapters

**The pinned run** is one viewport-tall pinned scene with a scroll runway. Native scroll drives a scrubbed GSAP ScrollTrigger timeline; the scene only reads that progress. Scrolling back rewinds. Nothing plays by itself.

| Beat | DOM (edges only) | Scene (scroll-scrubbed) |
|---|---|---|
| 0 Hero | "Opus plans. Cheaper models build, in parallel." + `claude --agent lead-dev-hybrid` + install | Finished miniature city at golden hour, drones idling, slow parallax |
| 1 Task | The real task prompt (short) | Camera tilts down to an empty blueprint plot beside the city |
| 2 Plan | "Plan mode on Opus, you approve" | Blueprint lines draw themselves; the plot splits into N lots labelled with the real worker slugs (DOM labels pinned to 3D) |
| 2 Lanes | Lane legend: agy, opencode | Drone cranes leave per-vendor hangars (unused lanes stay dark); buildings rise in parallel |
| 4 Verify + review | "Every branch re-tested, then reviewed by a different model" | A scan beam sweeps each building. Real `ok:false` workers get a flag and a crane returns (resume), or Opus finishes it |
| 5 Merge | "Merged into main" | Lots lift and slot into the city block; roads connect |
| 6 The bill | Claude USD vs stock, worker tokens (quota, never USD), wall time, pass | City recedes; DOM counters from the data file |

**After the run**, normal scrolling sections with small 3D accents (one small canvas moment each, or none):

1. **Which mode when.** direct / plan / lead-dev-hybrid. Bench rule: value scales with writing volume, not file count.
2. **Numbers.** Cells with n >= 3 only: min / median / max, losses shown, harness and model from the data file.
3. **One source, three CLIs.** `core/` -> `scripts/build.py` -> three outputs (Claude Code, OpenCode, Antigravity).
4. **Roster as a city map.** Packs are districts, agents are buildings; hover and focus cards. Derived from `../core/agents`. A hidden focusable list gives keyboard users the same cards.
5. **Safety.** Worktrees, the RUNNERS allowlist, no secrets to cold workers; the guards are a speed bump, not a sandbox.
6. **Install.** `./install.sh --all` and the flags, copy button.
7. **Build log.** The counts from section 4.

The site must be complete and useful with no 3D at all; that version is also the fallback.

## 7. Assets

- **Hand-modelled in Blender (live session, Blender MCP), plus procedural shaders and particles.** No external stock models, no AI-generated media.
- Modular low-poly kit: building modules (base, floor, roof caps, scaffold), a drone crane per lane, a hangar per lane, drafting table and blueprint sheet, road and tree props. One shared palette texture for all models.
- Export glTF with meshopt (or Draco) to `public/models/`. Pre-rendered stills per beat go to `public/stills/` (static fallback and OG image).
- Procedural: blueprint line-draw shader, scan beam, dust and light particles, tilt-shift post pass.
- Gate G2 (renders of the kit) comes before any scene code.

## 8. Target look (reference for the art-direction loop)

Art-direction rounds are judged against this. Verdicts should be short and name the part ("lot labels too small", "shadows too hard").

**Overall mood.** A warm, quiet, crafted miniature on a drafting table. Think architects' model on a desk in late sun, not a game and not a sci-fi hive. Calm, legible, a little tactile.

**Light.** Warm golden-hour key from low on one side with long soft shadows, a cool sky fill from the other. The light is warm; the paper stays paper. Nothing glows or blooms; the lit things are lit by the sun.

**Palette.** Paper and blueprint neutrals carry the page: a warm off-white paper, a deep blueprint navy ink, hairline blueprint blue for line work and the blueprint plot. **One accent per lane**: agy amber, opencode teal. The two are distinct for common colour-vision deficiencies and readable on both paper and navy; the magenta-violet hue is free for a future lane. A status pair (ok green, fail red) is used only for verify and review results, and never as the only cue (a flag shape, a tick or a cross always goes with it). Exact values live in `src/styles/tokens.css`.

**Models.** Matte low-poly shapes, flat shading with soft ambient occlusion baked into the one shared palette texture. Small bevels catch the sun. No glossy surfaces, no reflections.

**Depth of field.** On the high tier, shallow tilt-shift depth of field (a blurred band top and bottom, sharp band across the focus plane) sells the miniature. Medium and low tiers have no blur; the scale reads from shadows and the camera angle alone.

**Line work.** Blueprint lines are thin, hairline blue, drawn on by a shader as the plan forms. They are the only "UI" inside the scene.

**Camera.** One continuous camera, a three-quarter high angle. Pose is a function of scroll progress only, so scrubbing up and down is exact and repeatable. No lurches at beat boundaries.

**Typography and DOM.** One display face plus one mono face (Space Grotesk, JetBrains Mono), two families maximum. Text is at least 16px, in the ink colour on paper or the paper colour on navy, never over the busiest part of the scene during beats.

## 9. Quality tiers and constraints

- **High:** post-processing (tilt-shift), full particles, shadows at full resolution.
- **Medium:** no post-processing, reduced particles, smaller shadows.
- **Low / fallback** (no WebGL, `prefers-reduced-motion`, or a failed fps probe): no canvas. Pre-rendered stills from `public/stills/` per beat plus the full DOM content. The run's numbers and captions are all present as text.
- Every DOM animation has a `prefers-reduced-motion` path; so does every scene animation (it shows stills or jumps between beat poses).
- Responsive at 1440, 1024, 768 and 390.
- Keyboard reaches every hover card; focus mirrors hover.
- **Budgets:** JS under 400 KB gzipped, models at most 1.5 MB in total (lazy-loaded after first paint), LCP under 2.5 s (the hero is DOM text, the canvas never gates it), CLS under 0.05.

## 10. Open decisions carried forward

- Which run is featured. Candidate: `20261014T133904Z` features/hybrid/1 (agy + opencode lanes, verify passed, $0.182 Claude-side). Re-check against the data before G1.
- Whether the featured run's `ok:false` worker (if any) is shown as a resume or an Opus finish, whichever the run actually did.
- Domain (subdomain vs dedicated).
- Build log presentation: raw vs curated (recommended: curated timeline plus raw JSONL link).
- Merging `site/city` to `main` deploys to production. It happens only when the human says so.
