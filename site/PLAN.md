# SwarmKit Showcase Site — Build Plan (v2)

> Drop this file into the repo as `site/PLAN.md`. Claude Code reads it at the start of each phase.
> v2: restructured around an Igloo Inc–style continuous 3D world (see §2).

---

## 1. Goal

One site, two jobs:

1. **Explain SwarmKit.** A developer should understand what it is, how routing works, and how to install it in under 90 seconds.
2. **Prove SwarmKit.** The site is visually ambitious (a continuous scroll-driven 3D world) and shows, with evidence, that the swarm built it.

**Core principle (animation first):** the animation is the centre of the site and the text is small, at the edges, and never in the way. The world *is* the swarm: a procedurally grown honeycomb in which every agent is a cell, so the part that impresses and the part that explains are the same thing. The text only helps describe what the animation is already showing: one or two short lines per scene, small chips, and label cards that appear when you hover or focus a cell. Everything else lives in one compact Reference section after the finale. Text budget on a pinned scene at 1440x810: visible DOM text covers at most about 12% of the viewport, captions are one or two lines, and none sits over the centre of the scene (label cards and the finale command excepted).

### Non-goals

- No testimonials, logo farms, user counts, or star counts that don't exist yet.
- No text rendered in WebGL. Copy stays in the DOM (readable, selectable, indexable, accessible).
- No Houdini/VDB or other external asset pipelines. Everything in the scene is procedural code.
- No backend. Static site only.

---

## 2. Inspiration: Igloo Inc (igloo.inc)

Reference: https://www.awwwards.com/igloo-inc-case-study.html (built by Abeto; Three.js, Svelte, GSAP, Houdini, Blender).

| Take | Don't take |
|---|---|
| **Few chapters, deep engagement.** Igloo has 3 sections, each packed with interaction | UI and text rendered in WebGL (hurts a11y/SEO; Igloo's lowest Awwwards score was usability) |
| **One continuous world, one camera.** Scroll moves the camera between scenes | Houdini/VDB volume data and custom exporters |
| **A signature material.** Ice there, **honeycomb** here | Crypto/luxury tone; ours is precise and technical |
| **Styled transitions** (their frost dissolve becomes our hex dissolve) plus subtle chromatic aberration | |
| **Real-time intro sequence** that sets the tone | |
| **Particle finale** in the footer | |
| **Muted two-colour palette** plus one accent | |
| **Grey-box previs before polish** | |

---

## 3. Honesty rules (non-negotiable)

The site's credibility *is* the product claim.

- **Benchmarks:** publish only real runs. Report medians over at least 3 runs per fixture per agent type, and link the raw `benchmark_metrics.json`. If SwarmKit loses on a fixture (e.g. T1 overhead), show it.
- **Harness disclosure:** state which harness and model produced each number. The current benchmark runs on Antigravity (`agy`) with `gemini-3.8-flash-high`; the site is built with Claude Code. Say both.
- **Procedural claim:** the scene contains zero external models, textures, or volume data. If that changes, the claim changes with it.
- **Build log:** separate what the human did (gate approvals, art-direction feedback, manual edits) from what agents did. Count human interventions and show the number, including art-direction rounds.

---

## 4. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Astro (static output) | Zero JS by default; the canvas is one island |
| Styling | Tailwind CSS + `tokens.css` | Showroom default |
| 3D | Vanilla `three` (no React/R3F) | One fewer framework |
| Post-processing | `three/examples/jsm/postprocessing` (EffectComposer) | Chromatic aberration and grain, **high tier only** |
| Particles | `GPUComputationRenderer` (`three/examples/jsm/misc`) | GPU simulation for the finale swarm |
| Motion | GSAP + ScrollTrigger + Lenis | Follow the 5 fluid-motion rules in `premium-frontend-system` |
| Language | TypeScript | — |
| Hosting | Cloudflare Pages via `wrangler` | Uses SwarmKit's own Cloudflare MCP suite, which doubles as a demo |

---

## 5. Architecture

```
┌─────────────────────────────────────────────┐
│  <canvas> position:fixed, full viewport     │  ← one WebGL world, one camera
│  z-index: 0, pointer-events only on nodes   │
├─────────────────────────────────────────────┤
│  DOM chapters (normal flow, z-index: 1)     │  ← all text lives here, small, at the edges
│  Each chapter = a tall runway holding one   │
│  position:sticky, 100vh scene               │
└─────────────────────────────────────────────┘
```

- **One scroll source of truth.** ScrollTrigger computes `{ chapter, chapterProgress, globalProgress }` into a plain shared state object. The scene reads it each frame. Nothing else in the scene listens to scroll.
- **Camera path:** one `CatmullRomCurve3` for the whole site. Each chapter owns a segment of it plus a look-at target. Keyframes live in data (`src/lib/world/camera-path.ts`), not scattered through code.
- **Animation first, text small.** The canvas is the centre; each chapter `<section>` is a tall runway (`--runway`, in vh, from `motion-config.ts`) holding one sticky 100vh scene, and every piece of scene text sits on that layer. Captions are pre-rendered and stacked, and the chapter only writes their opacity (no DOM mutation mid-scroll). DOM content still renders immediately (the intro tagline is the LCP element) and the canvas initialises after first paint (`requestIdleCallback`, with a timeout fallback) and fades in. Hover or focus detail (agent name, tier, one-line role) is a label card placed at the projected cell centre by `pick.ts`, driven by a pointer raycast and by a hidden, focusable agent list. Reduced motion, `?tier=fallback` and no-JS get a static layout of the same captions plus the Reference section: a complete page with no canvas.
- **Chapter modules:** each chapter is a module exposing `enter()`, `update(progress)`, `exit()` and operating on the shared world. No per-chapter renderers.

### Repo layout

```
swarmkit/
├── core/agents/                   # source of truth for the roster
├── core/skills/
├── scripts/benchmark_swarm.py
└── site/
    ├── PLAN.md                    # this file
    ├── CLAUDE.md                  # site rules for Claude Code (see §13)
    ├── BRIEF.md                   # Showroom G1 output
    ├── .showroom/state.json
    ├── .buildlog/                 # dispatch, human, and art-direction logs (see §10)
    ├── public/data/benchmark_metrics.json
    └── src/
        ├── content/               # collections: agents, buildlog
        ├── styles/tokens.css
        ├── lib/world/
        │   ├── world.ts           # renderer, scene, camera, loop, tiers
        │   ├── camera-path.ts
        │   ├── sphere.ts          # procedural Goldberg sphere layout (pure, build + browser)
        │   ├── honeycomb.ts       # globe + moon layout, growth, instanced cells
        │   ├── transitions.ts     # hex-dissolve pass
        │   ├── swarm-particles.ts # GPGPU finale
        │   ├── pick.ts            # pointer raycast + keyboard list -> cell highlight + label card
        │   ├── scene-dom.ts       # opacity-only DOM driver for the pinned scenes
        │   └── chapters/          # intro, hive, cells, proof, finale
        ├── pages/lookdev.astro    # isolated material/effect test bench (not linked in nav)
        ├── components/chapters/   # one pinned scene per chapter
        ├── components/Reference.astro, Nav.astro
        └── pages/index.astro
```

---

## 6. Chapters

Each chapter is a runway with one pinned scene. Scroll lengths live in `motion-config.ts` (`motion.runway`, in viewport heights). The DOM text per scene is deliberately small.

| # | Chapter (runway) | Scene text (small, at the edges) | World |
|---|---|---|---|
| 0 | **Intro** (≈ 3–4 s, timed, skippable; 100vh) | A small corner wordmark and one tagline line. No hero block | A single cell appears at the origin and divides; the lattice grows outward ring by ring. Skippable on click, key, or scroll; skipped entirely under reduced motion |
| 1 | **The Hive** (300vh) | One caption that steps with the packet (task in, classified, routed, gates in parallel), pre-rendered and crossfaded by opacity. Small T1/T2/T3 chips light up per step. Three small focusable buttons (the example tasks) replay their route | Camera pulls back to the full lattice. A glowing task packet, scrubbed by scroll, enters, is classified, travels to a specialist cell, then fans out to the three gate cells simultaneously |
| 2 | **The Cells** (300vh) | One caption and a slim tier legend. No roster panels. Hover or focus a cell to get a label card (name, tier, one-line role) | Camera flies along the lattice; the hovered or focused cell lifts and glows. A hidden, focusable agent list (arrow keys) drives the same highlight, so the keyboard works |
| 3 | **Proof** (150vh) | A slim HUD strip of readouts: ponytail diff, benchmarks (`pending` until real data exists), harness disclosure, and the real build-log counts | Lattice recedes and dims to a backdrop. Hex-dissolve transition in; the canvas never competes with the numbers |
| 4 | **Swarm finale: install** (400vh, the climax) | The assembled `./install.sh --all` holds centre screen with a small copy button beside it. Installer flags, platforms and counts appear as small chips only after it has formed | The lattice breaks apart into a GPU particle swarm that flocks and then assembles into `./install.sh --all` |
| R | **Reference** (normal flow, after the finale) | Compact: roster, installer flags, platforms, MCP servers, skills, slash commands, example routes, benchmark table, harness disclosure, build-log timeline. Reachable from the nav | None (opaque, covers the canvas) |

---|---|---|---|
| 0 | **Intro** (≈ 3–4 s, skippable) | "SwarmKit" with DOM text scramble, then the tagline | A single cell appears at the origin and divides; the lattice grows outward ring by ring. Skippable on click, key, or scroll; skipped entirely under reduced motion |
| 1 | **The Hive**: how it works | Pitch, `./install.sh --all` copy button, then the routing story: T1/T2/T3, explore → execute → parallel quality gate | Camera pulls back to reveal the full lattice. A glowing task packet enters, is classified, travels to a specialist cell, then fans out to the three gate cells simultaneously |
| 2 | **The Cells**: roster | All agents by tier; hover or focus shows role, permissions, tier. Example tasks ("fix typo", "add API route", "refactor auth") replay their routes | Camera flies along the lattice; the hovered/focused agent's cell lifts and glows. The DOM list is the accessible source of truth |
| 3 | **Proof** | Ponytail diff shrinking to `net: -N lines`; benchmark table and chart with harness disclosure; "built by SwarmKit" timeline | Lattice recedes and dims to a backdrop. Hex-dissolve transition in; the canvas never competes with the numbers |
| 4 | **Swarm finale**: install | Platforms (OpenCode / Antigravity / Claude Code), installer flags, MCP servers, skills, slash commands, horology demo link, footer | The lattice breaks apart into a GPU particle swarm that flocks and then assembles into `./install.sh --all` |

---

## 7. World spec

### 7.1 Hex globe (`sphere.ts`, `honeycomb.ts`)

- The lattice is a **Goldberg sphere**, not a flat grid: GP(4,0), built procedurally from an icosahedron subdivided 4 times per edge and dualised. That gives 162 cells: 150 hexagons plus exactly 12 pentagons (the icosahedron corners). No assets. `sphere.ts` is a pure function (no three.js), so the same layout runs at build time (Node: the fallback backdrop, `scripts/layout-check.mjs`) and in the browser.
- The subdivided mesh is relaxed (edge springs) so cell sizes stay within about 17 percent of each other. The sphere is oriented by the layout: the core cell (a hex on an icosahedron edge midpoint, flanked by two pentagons) sits on +Z, facing the hive camera.
- Cells are **prisms extruded along the surface normal** with a hex or pentagon footprint, scaled per cell from its own neighbour spacing. Two `InstancedMesh`es (hex, pentagon) share **one** material (the locked cell material) with the per-instance attributes colour, `aEmissive` and `aLift` (lift runs along the cell normal). A dark core sphere in the background colour sits just under the cells so the far side never shows through the seams.
- **Agent cells** are assigned by tier to bands spread outward by **geodesic ring** (graph distance from the core cell): `lead-dev` at the core, then T1 (explore, git-specialist, junior-dev), then domain specialists, then quality gates (security-auditor, code-proofreader, release-tester, test-writer). Agents in a band are spread evenly around their ring by azimuth. Assignment is computed from agent data (§8). Never hardcode positions.
- **Filler cells** (inert, dimmer) complete the sphere so it reads as a structure, not a diagram. Growth (intro) is ring by ring outward by geodesic distance with staggered scale and extrude; the back hemisphere grows with the limb.
- Showroom sub-swarm: a small **moon cluster** of flat hexes (showroom at its centre, its workers around it) floating beside the globe, offset in orbit and derived from the layout. It grows last (it also sets up the "built by SwarmKit" story).
- Camera: the scroll **orbits the camera around a still globe** (`camera-path.ts`, one curve): intro pull-back from the core cell, the whole globe and its moon for the hive, a low surface fly-over across the front hemisphere for the cells, a wide dim recede for the proof, a slow drift for the finale.
- Material: a `MeshStandardMaterial` patched with `onBeforeCompile` giving a translucent wax/resin look via fresnel rim, fake subsurface through a thickness term, and an emissive core for agent cells. No textures. The footprint mask is a 5- or 6-sided polygon distance, so the pentagon cells get pentagon cores.

### 7.2 Task packet

- A small bright particle with a short trail (a ribbon from its last N positions) moving along a curve between cell centres.
- It uses the one accent colour on the site. It is the visual thread that ties chapter 1 to chapter 2.

### 7.3 Transitions (`transitions.ts`)

- **Hex dissolve:** a full-screen pass that dissolves between chapter states using a hex-grid distance field, driven by `chapterProgress`.
- **Chromatic aberration and film grain:** subtle, and only on the high tier.

### 7.4 Particle finale (`swarm-particles.ts`)

- `GPUComputationRenderer` with position and velocity textures.
- Behaviour: curl-noise flocking, then an attraction to target points blended by `chapterProgress`.
- Targets: rasterise `./install.sh --all` to an offscreen 2D canvas and sample the lit pixels into a target texture. Procedural, no assets.
- Counts: high 16k, medium 4k, low replaced by a static SVG.

### 7.5 Quality tiers (`world.ts`)

| Tier | Detect | Features |
|---|---|---|
| **High** | Desktop GPU, ≥ 8 cores | Full post-processing, 16k particles, DPR ≤ 2 |
| **Medium** | Most laptops, recent phones | No post-processing, 4k particles, DPR ≤ 1.5, simpler cell shader |
| **Low / fallback** | No WebGL, `prefers-reduced-motion`, or failed fps probe | Static SVG of the lattice per chapter; no intro; no canvas |

- After mount, run a ~1 s fps probe. Below 45 fps drop one tier; below 30 fps drop to fallback.
- Pause rendering when the tab is hidden.
- Dispose of everything on teardown.

---

## 8. Data pipeline (keep the site in sync with the repo)

- **Agents:** an Astro content collection reads `../core/agents/*.md` frontmatter at build time. Tier comes from a small mapping in `src/content/tiers.ts`, because tier isn't in the frontmatter. The same data feeds both the DOM roster and the lattice cell assignment.
- **Counts** (agents, skills, MCP servers, slash commands) are computed at build time. Never hardcode "23 agents".
- **Benchmarks:** read from `public/data/benchmark_metrics.json` (real runs only); render medians and link the raw file.
- **Build log:** `.buildlog/*.jsonl` is summarised at build time into the Proof timeline.

---

## 9. Art direction loop

Shader and look work is where agents need human eyes most. Make the loop explicit and cheap.

1. All look work happens on `src/pages/lookdev.astro`: cell material, dissolve, packet trail, and particles, each isolated, with sliders for every uniform.
2. The agent screenshots the lookdev page (Chrome DevTools MCP), compares it against the direction in `BRIEF.md`, and proposes changes.
3. The human gives short verdicts: "rim too strong", "grain reads as dirt", "yes".
4. Each round is logged in `.buildlog/artdirection.jsonl` (round number, what changed, verdict).
5. **Lock values once approved:** approved uniforms move into `tokens.css` or `world/config.ts` and are not touched again without a new round.

---

## 10. Capturing the build log

The Proof chapter needs data recorded *while* building, not reconstructed afterwards.

1. **Showroom state:** `.showroom/state.json` tracks stages, gates, decisions, and assets. Commit it at every gate.
2. **Agent dispatches:** a Claude Code hook in `.claude/settings.json` appends one JSON line per subagent completion to `.buildlog/dispatch.jsonl` (timestamp, agent, short summary).
   - ⚠️ Check the current Claude Code hooks docs for the exact event name and payload fields before wiring this. Fall back to parsing session transcripts if the payload is too thin.
3. **Human interventions:** gate approvals and manual edits go in `.buildlog/human.jsonl`; art-direction rounds go in `.buildlog/artdirection.jsonl`.
4. **Git:** one commit per phase and per approved art-direction round.

---

## 11. Phases

Each phase ends with a commit and, where marked, a human gate.

### Phase 0 — Proof data (before any design work)

> **Status:** the benchmark items are deferred; the human will supply the benchmark file later. `scripts/benchmark_swarm.py` is not in this repo. Build-log capture is done.

- [ ] Make `benchmark_swarm.py` fail loudly instead of recording placeholder tokens (dry-run inserts 2000) or zero tokens (JSON parse failure).
- [ ] Run `--fixture all` at least 3 times; save to `site/public/data/benchmark_metrics.json`.
- [ ] Optional: add a Claude Code harness variant. Verify the fields `claude -p --output-format json` returns first.
- [ ] Set up build-log capture (§10).

**Done when:** real numbers exist, including any unflattering ones.

### Phase 1 — Brief (Showroom G1)

- [ ] `BRIEF.md`: audience (developers evaluating agent setups), tone (precise, confident, no hype), chapters (§6), honesty rules (§3), Igloo take / don't-take (§2), and a written description of the target look for the art-direction loop.

**Gate G1:** human approves the brief.

### Phase 2 — Grey-box previs (highest risk, do it early)

- [ ] `world.ts` + `camera-path.ts` + `honeycomb.ts` with **untextured grey** cells, no post-processing.
- [ ] Drive `globalProgress` from a range slider on a bare test page; stub all five chapters as camera segments.
- [ ] Measure on a real mid-range phone.

**Done when:** the camera journey reads clearly in grey; ≥ 55 fps desktop, ≥ 45 fps mid-range phone.
**Go/no-go:** if the grey version isn't compelling, fix the camera path and composition. Polish will not rescue it.

### Phase 3 — Design system + look dev (Showroom G2)

- [ ] `tokens.css`: two-colour muted palette plus one accent (the task packet), type scale (one display face plus one mono face), spacing scale.
- [ ] `lookdev.astro`: cell material, hex dissolve, packet trail, particle swarm, each isolated with sliders.
- [ ] Run the art-direction loop (§9) until every element is approved and locked.

**Gate G2:** human approves the tokens and the locked look.

### Phase 4 — DOM chapters and content (Showroom G4)

- [ ] Astro scaffold, layout, content collections (§8).
- [ ] All five chapters as DOM with final copy, no canvas yet.
- [ ] Responsive at 1440 / 1024 / 768 / 390. The site must be complete and useful at this point with no 3D at all; this also serves as the fallback.

**Gate G4:** human reviews structure and copy.

### Phase 5 — Integration

- [ ] Mount the fixed canvas; sync ScrollTrigger → shared state → world (§5).
- [ ] Lenis + GSAP per the 5 fluid-motion rules (`duration: 1.0`, `lenis.on('scroll', ScrollTrigger.update)`, `gsap.ticker.lagSmoothing(0)`, no mid-scroll DOM mutations, no triggers closer than 150px).
- [ ] Intro sequence with skip.
- [ ] Chapter transitions, packet routing, roster hover/focus → cell highlight.
- [ ] Particle finale.
- [ ] Quality tiers and fps probe; fallback SVGs.

### Phase 6 — QA (Showroom G5)

- [ ] Lighthouse (mobile): Performance ≥ 90, Accessibility 100, Best Practices ≥ 95, SEO 100.
- [ ] Zero console errors or warnings on every tier.
- [ ] Keyboard-only navigation, including roster focus → cell highlight; visible focus states.
- [ ] Tested with `prefers-reduced-motion: reduce`, WebGL disabled, and each tier forced.
- [ ] Run `security-auditor`, `code-proofreader`, and `/ponytail-review` on the site code; results go in the build log.
- [ ] Run `seo-specialist`: meta tags, OG image (rendered from the lattice), JSON-LD (`SoftwareSourceCode`).

**Gate G5:** human final review.

### Phase 7 — Deploy

- [ ] Cloudflare Pages via `wrangler`; production branch `main`, preview on PRs.
- [ ] Custom domain (see §14).
- [ ] Regenerate the Proof chapter from the final `.buildlog/` data and deploy again.
- [ ] Add the site URL to the SwarmKit README.

---

## 12. Budgets

| Metric | Budget |
|---|---|
| Total JS (gzipped) | < 400 KB (three + postprocessing + GPGPU + GSAP + Lenis) |
| External 3D assets | 0 bytes |
| LCP (mobile, 4G) | < 2.5 s (DOM text is the LCP element) |
| Canvas first frame | After LCP; never blocks text |
| CLS | < 0.05 |
| Frame rate | ≥ 55 fps high tier, ≥ 45 fps medium tier, or auto-downgrade |
| Fonts | ≤ 2 families, `font-display: swap`, subset |

---

## 13. `site/CLAUDE.md` (starter)

```markdown
# SwarmKit site — rules for Claude Code

- Read PLAN.md before each phase. Work one phase at a time and stop at gates.
- Animation first, text small: the world is the centre; scene text is one or two short lines, small chips, and hover/focus label cards. Detail lives in the Reference section. On a pinned scene at 1440x810 visible text covers at most about 12% of the viewport and never sits over the centre (label cards and the finale command excepted).
- Static Astro site. No backend, no React. Three.js is vanilla, in one fixed-canvas island.
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
```

---

## 14. Open decisions

- [ ] **Domain:** subdomain on an existing domain, or a dedicated one.
- [ ] **Build log:** raw or curated. Recommendation: curated timeline with a link to the raw JSONL.
- [ ] **Sound:** Igloo uses sound. Recommendation: skip for v1; if added, it is off by default with a visible toggle.
- [ ] **Horology demo:** link (recommended) or embed.
- [ ] **Claude Code benchmark variant:** worth adding so the proof matches the build tool?

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Grey-box journey isn't compelling | Phase 2 go/no-go before any polish |
| Shader look stalls in endless iteration | Lookdev page, logged rounds, lock-on-approve rule (§9) |
| Mobile misses the fps budget | Quality tiers, fps probe auto-downgrade, SVG fallback |
| Particle finale too heavy | Medium tier at 4k; the finale can fall back to the static lattice |
| Benchmarks look bad on simple tasks | Publish anyway and explain the tiered-routing trade-off |
| Build-log hook payload too thin | Parse Claude Code session transcripts instead |
| Site drifts from the repo | All counts, roster data, and cell assignments are generated at build time |
| Spectacle buries the message | Phase 4 requires a complete, useful site with zero 3D before integration |

---

## 16. Kickoff prompts for Claude Code

**Phase 0**
> Read site/PLAN.md. Execute Phase 0 only. Make benchmark_swarm.py fail loudly instead of recording placeholder or zero tokens, run all fixtures 3 times, save the results to site/public/data/benchmark_metrics.json, and set up the build-log capture from §10. Stop and report when done.

**Phase 1**
> Read site/PLAN.md. Use the showroom agent to run S0–S1 and produce site/BRIEF.md from sections 1, 2, 3 and 6 of the plan, including a written target-look description. Stop at G1.

**Phase 2**
> Read site/PLAN.md §5 and §7. Use the animation-specialist to build the grey-box previs: world.ts, camera-path.ts and honeycomb.ts with untextured cells and no post-processing, driven by a range slider on a bare test page with all five chapters stubbed as camera segments. Report fps against the Phase 2 budget and stop for go/no-go.

**Phase 3**
> Read site/PLAN.md §9. Build src/pages/lookdev.astro with the cell material, hex dissolve, packet trail and particle swarm isolated and slider-controlled. Screenshot each via Chrome DevTools, compare against BRIEF.md, and propose one change per element per round. Log each round and wait for my verdict.

**Phases 4–7**
> Read site/PLAN.md. Continue the showroom pipeline from the current stage in .showroom/state.json. Execute Phase N only and stop at its gate.
