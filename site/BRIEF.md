# SwarmKit Showcase Site: Brief (Showroom G1)

Derived from PLAN.md sections 1, 2, 3, 6, 7 and 9. If this brief and PLAN.md disagree, PLAN.md wins and this file gets corrected.

## 1. Goal

One site, two jobs.

1. **Explain SwarmKit.** A developer understands what it is, how routing works, and how to install it in under 90 seconds.
2. **Prove SwarmKit.** The site is a continuous scroll-driven 3D world, and it shows with evidence that the swarm built it.

Core principle (animation first): the animation is the centre and the text only helps describe it. The world is the swarm, a procedurally grown honeycomb in which every agent is a cell. The part that impresses and the part that explains are the same thing.

## 2. Audience and tone

- **Audience:** developers evaluating agent setups (Claude Code, OpenCode, Antigravity). They read docs, distrust hype, and will check numbers.
- **Tone:** precise, confident, no hype. Short declarative sentences. Say what it does and what it costs. No superlatives, no "revolutionary", no crypto/luxury register.
- **Copy rule:** all copy lives in the DOM. Nothing is rendered as text in WebGL. The animation is the centre; text is small, short and at the edges (one or two lines per scene, small chips, hover/focus label cards), with the detail in one compact Reference section. Honesty rules below are unchanged.

## 3. Non-goals

- No testimonials, logo farms, user counts, or star counts.
- No text in WebGL.
- No Houdini/VDB or other external asset pipelines.
- No backend; static site only.
- No sound in v1.

## 4. Honesty rules (non-negotiable)

- **Benchmarks are pending.** `public/data/benchmark_metrics.json` does not exist yet. Until real data exists, the Proof chapter renders an honest "benchmarks pending" state. No placeholder or illustrative numbers, ever.
- When data exists: medians over at least 3 runs per fixture per agent type, raw file linked, and losses shown (for example T1 overhead).
- **Harness disclosure:** state which harness and model produced each number. The benchmark runs on Antigravity (`agy`) with `gemini-3.8-flash-high`; the site is built with Claude Code. Say both.
- **Procedural claim:** the scene contains zero external models, textures, or volume data, and zero AI-generated media. If that changes, the claim changes with it.
- **Build log:** separate what the human did (gate approvals, art-direction feedback, manual edits) from what agents did. Show the count of human interventions, including art-direction rounds.
- **Derived facts only:** agent, skill, MCP server and slash command counts are computed at build time from `../core/agents` and `../core/skills`. Nothing is hardcoded and nothing is invented.

## 5. Igloo Inc: what we take and what we don't

Reference: igloo.inc (Abeto; Three.js, Svelte, GSAP, Houdini, Blender).

| Take | Don't take |
|---|---|
| Few chapters, deep engagement | UI and text rendered in WebGL |
| One continuous world, one camera; scroll moves the camera | Houdini/VDB volume data and custom exporters |
| A signature material (their ice, our honeycomb) | Crypto/luxury tone |
| Styled transitions (their frost dissolve, our hex dissolve), subtle chromatic aberration | |
| Real-time intro sequence that sets the tone | |
| Particle finale in the footer | |
| Muted two-colour palette plus one accent | |
| Grey-box previs before polish | |

## 6. Chapters

Each chapter is a scroll runway with one pinned, viewport-tall scene. DOM text is small and at the edges.

| # | Chapter | DOM content (small) | World |
|---|---|---|---|
| 0 | Intro (about 3-4 s, skippable) | Corner wordmark and one tagline line | One cell appears at the origin and divides; the lattice grows outward ring by ring. Skippable on click, key or scroll; skipped entirely under reduced motion |
| 1 | The Hive: how it works (300vh) | One caption stepping with the comet (task in, classified, routed, gates in parallel), T1/T2/T3 chips, three focusable example-route replay buttons | Camera pulls back to the full lattice. A small hard-edged violet comet enters, holds at the core panel while a thin scanning ring is engraved onto it, eases to a specialist panel, then fans out to the three gate panels at once (they leave together and land together, each landing sends a short ripple ring across the surface) |
| 2 | The Cells: roster (300vh) | One caption, a slim tier legend, and a label card (name, tier, one-line role) on hover or focus of a cell. No roster panels | Camera flies along the lattice; the hovered or focused agent's cell lifts and brightens (no glow). A hidden focusable agent list drives the same highlight for keyboard users |
| 3 | Proof (150vh) | A slim HUD strip: ponytail diff, benchmarks (**"pending" until real data exists**), harness disclosure, build-log counts | Lattice recedes and dims to a backdrop. Hex-dissolve transition in; the canvas never competes with the numbers |
| 4 | Swarm finale: install (400vh) | The assembled `./install.sh --all` holds centre screen with a small copy button; flags, platforms and counts as small chips only after it forms | Lattice breaks into a GPU particle swarm that flocks, then assembles into `./install.sh --all` |
| R | Reference (after the finale) | Compact roster, flags, platforms, MCP servers, skills, slash commands, example routes, benchmark table, harness disclosure, build-log timeline | None |

The site must be complete and useful with no 3D at all (Phase 4 requirement); that version is also the fallback.

## 7. Assets

100% procedural. **No Google Flow, no AI-generated media, no external assets.** Showroom S3 (asset request pack) is skipped. Every visual is generated by code (instanced hex prisms, shaders, GPGPU particles, canvas-rasterised text sampled to points).

## 8. Target look (reference for the art-direction loop)

This is what the art-direction rounds (PLAN section 9) are judged against. Verdicts should be short and refer to the named parts below ("rim too strong", "core too hot", "grain reads as dirt").

**Overall mood.** A dark, quiet, technical interior. Think a beehive seen through an instrument, not a fantasy hive. Restrained, low-saturation, high contrast between structure and the single bright thing moving through it.

**Palette (muted two-colour plus one accent).**
- Colour A: deep desaturated ink (near-black with a slight cool or warm cast) for background and recessive geometry.
- Colour B: a muted wax/amber-bone tone for cell bodies and highlights, kept low in saturation.
- Accent: ONE colour, used for the comet (head, tail, sparks and the crisp rings it draws on landing) and nothing else (no UI accents, no hover effects on panels, no links, never on the globe, moon or lights). If the accent appears anywhere but the comet, that is a defect.
- Exact values are proposed in Phase 3 and locked in `tokens.css`; this brief fixes the roles, not the hex codes.

**Cell material (flush speckled stone, round 5).** Replaces the pearlescent ceramic of round 4 (the human found the globe textureless, its panels misaligned and its glow unwanted). Every colour is a mix of the five palette tokens; no new colour token and never the accent. Nothing on the globe glows.
- **Flush panels:** every panel stands at the same radius above its sphere with one tiny uniform relief (about 3% of a cell), not a column. Each panel's outline is its own Voronoi polygon inset by half a seam, so the engraved seam has one constant width over the whole globe (and pentagons match hexagon neighbours). A hairline bevel keeps the seam edge crisp. The seam floor is dark and matte (the background ink), so seams read as thin recessed lines, never as lit channels. Axes: seam too wide or too thin, relief too tall (columns) or invisible.
- **Speckled stone:** procedural flecks (hashed grid dots in three or four sizes, in wax, text and ink-2 tones, plus a slow blotchy mottle over a wax-dim to wax body). Matte with a gentle satin highlight from the moving key. The speckle is anchored per panel with a random rotation and offset, so each panel reads as its own piece of stone and the grain never lines up across a seam. Fleck size is tuned to read at the hive viewing distance (2 to 3 px flecks), and flecks smaller than a pixel fade out, so the stone never shimmers. Axes: too busy (dirt, noise), too faint (flat), too coarse (spots).
- **Agent panels (no glow):** slightly lighter stone and an engraved ring inlay cut into the panel. Rings differ by band so bands stay readable: core three rings and a centre dot, T1 one wide ring, domain specialists two rings, quality gates one ring and a centre dot, the moon a fine ring. Filler panels are plain stone.
- **Lift and state:** a hovered or focused panel rises a few percent of a cell and its tone brightens. No emissive, no bloom, no colour change to the accent.
- **Studio (high tier reflection):** a procedural soft-box environment (ink room, overhead box, warm key panel, cool strip) baked once into a low-intensity reflection map. Medium tier has no reflection, one mottle octave, no fine flecks, and a slightly stronger hemisphere light instead.
- **Moon:** a small round sphere (a Goldberg GP(2,0), 42 cells: 30 hexagons and 12 pentagons) built exactly like the globe with the same stone, seams, inlay and lights; showroom sits on the cell that faces the hive camera, its workers on the rings around it. It grows last.

**Surroundings (round 5).** The globe sits in a quiet studio, not a void, and nothing around it glows: no atmosphere halo, no dust, no glowing floor.
- **Moving light:** the key light sweeps round the globe as the camera orbits (it follows the camera azimuth at a fraction of its rate), with a soft cool kicker from behind, so highlights travel across the stone and catch the seam bevels. The moon uses the same lights.

**Lattice composition.** Rings grow outward from a single origin cell with staggered scale and extrude, so growth reads as organic but orderly. `lead-dev` at the core, tier bands outward, filler cells completing the structure. Depth of field is implied by dimming and rim falloff with distance, not blur.

**Comet (round 5).** Replaces the glowing task packet. A small, hard, bright head (a crisp disc with a light core and an accent rim), a tail that tapers to a point with crisp edges and lengthens and shortens with the speed it is seen moving at, and a few short-lived sparks it sheds (hard dots that shrink away). Opaque and violet only: no additive blending, no soft sprite, no haze. It is the only saturated element on screen. Routes are great-circle arcs that hug the surface at one low constant lift (no horizon zigzag). The velocity profile is real: every leg eases in and out (it accelerates out of each stop and decelerates into the next); the fan-out to the three gates leaves together and lands together. At classification it holds briefly while a thin scanning ring is engraved onto the core panel (a crisp line); on landing at a specialist or gate panel a short ripple ring travels across the surface and the panel lifts a little. While the hive scene is on screen the look-at leans gently toward the comet head. The example-task buttons replay the same choreography in real time.

**Camera and transitions (round 5).** One continuous camera: a single position curve and a single look-at curve for the whole journey (no per-chapter easing that stops the target at every boundary), continuous in speed and acceleration at every chapter boundary. Scroll maps to camera arc length with a speed that varies smoothly where the runways change, so the camera never lurches at a boundary. The world reads a critically damped copy of the scroll progress (about 0.15 s). Pinned scenes hand over with one ease and complementary opacities (they always sum to 1), timed to when the incoming text actually comes on screen.

**Hex dissolve transition.** A full-screen dissolve driven by a hex-grid distance field: cells of the outgoing state shrink or fade in a wavefront across the screen, revealing the next state. Edges are crisp, the hex size matches the lattice scale so the transition feels native to the world. Axes: too slow, hex too large or too small, wavefront too uniform.

**Chromatic aberration and grain (high tier only).** Subtle. Aberration is a slight RGB split increasing toward the screen edges, barely visible at the centre. Grain is fine and low contrast, there to soften banding in dark gradients. If either is noticeable at a glance, it is too much. Medium and low tiers have neither.

**Particle finale.** Small, dim-to-bright particles in Colour B (not the accent) with curl-noise flocking, then converging on the rasterised `./install.sh --all` target. Should read as the lattice dissolving into a swarm, not fireworks.

**Typography and DOM.** One display face plus one mono face, two families maximum. Round 4 made the text larger after the human could not notice it: captions, chips, HUD readouts, the tier legend and the label cards are 16px in the --text colour (not --wax), with a little more padding. The intro is a large display wordmark (about 72px) and a 24px tagline placed off-centre so the globe stays the hero; the wordmark scrambles in, then shrinks into the corner mark on scroll. Text still sits at the edges, never covers the centre of the globe, and the copy must not compete with the canvas; the text-area budget is measured per scene (scripts/qa-scenes.mjs).

## 9. Quality tiers and constraints (summary)

- High: post-processing, 16k particles. Medium: no post-processing, 4k particles. Low/fallback (no WebGL, reduced motion, failed fps probe): static SVG lattice, no intro, no canvas.
- Every DOM animation has a `prefers-reduced-motion` path.
- Responsive at 1440, 1024, 768, 390.
- Budgets: JS under 400 KB gzipped, 0 bytes of external 3D assets, LCP under 2.5 s (DOM text), CLS under 0.05.

## 10. Open decisions carried forward (not blocking G1)

- Domain (subdomain vs dedicated), for Phase 7.
- Build log presentation: raw vs curated (recommended: curated timeline plus raw JSONL link).
- Horology demo: link (recommended) or embed.
- Whether to add a Claude Code benchmark variant.
