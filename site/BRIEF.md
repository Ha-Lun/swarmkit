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
| 1 | The Hive: how it works (300vh) | One caption stepping with the packet (task in, classified, routed, gates in parallel), T1/T2/T3 chips, three focusable example-route replay buttons | Camera pulls back to the full lattice. A glowing task packet enters, is classified, travels to a specialist cell, then fans out to the three gate cells at once |
| 2 | The Cells: roster (300vh) | One caption, a slim tier legend, and a label card (name, tier, one-line role) on hover or focus of a cell. No roster panels | Camera flies along the lattice; the hovered or focused agent's cell lifts and glows. A hidden focusable agent list drives the same highlight for keyboard users |
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
- Accent: ONE colour, used for the task packet and nothing else (no UI accents, no hover glows on cells, no links). If the accent appears anywhere but the packet and its trail, that is a defect.
- Exact values are proposed in Phase 3 and locked in `tokens.css`; this brief fixes the roles, not the hex codes.

**Cell material (translucent wax/resin).**
- **Body:** a hex prism that reads as thick translucent wax, softly lit, no hard specular sparkle. No textures.
- **Fresnel rim:** a soft, thin brighter edge where the surface turns away from the camera. It defines silhouettes against the dark. Verdict axes: too strong (looks like neon outline / glass toy), too weak (cells vanish into background).
- **Fake subsurface:** a thickness term that lets light bleed warmer through thinner regions (top edges, cell corners) and stay denser at the centre. Should suggest depth, not glow. Axes: too waxy/flat, too jelly-like.
- **Emissive core (agent cells only):** a contained inner glow in Colour B, brighter for the cell that is active or hovered. Filler cells have no core and are dimmer, so agent cells read as the structure's nodes. Axes: too hot, too uniform, bleeding past the cell edge.
- **Lift and state:** hovered or focused cells rise slightly and their core brightens. No colour change to the accent.

**Lattice composition.** Rings grow outward from a single origin cell with staggered scale and extrude, so growth reads as organic but orderly. `lead-dev` at the core, tier bands outward, filler cells completing the structure. Depth of field is implied by dimming and rim falloff with distance, not blur.

**Task packet.** A small, bright point in the accent colour with a short ribbon trail fading to nothing. It is the only saturated element on screen, and the eye should always find it first.

**Hex dissolve transition.** A full-screen dissolve driven by a hex-grid distance field: cells of the outgoing state shrink or fade in a wavefront across the screen, revealing the next state. Edges are crisp, the hex size matches the lattice scale so the transition feels native to the world. Axes: too slow, hex too large or too small, wavefront too uniform.

**Chromatic aberration and grain (high tier only).** Subtle. Aberration is a slight RGB split increasing toward the screen edges, barely visible at the centre. Grain is fine and low contrast, there to soften banding in dark gradients. If either is noticeable at a glance, it is too much. Medium and low tiers have neither.

**Particle finale.** Small, dim-to-bright particles in Colour B (not the accent) with curl-noise flocking, then converging on the rasterised `./install.sh --all` target. Should read as the lattice dissolving into a swarm, not fireworks.

**Typography and DOM.** One display face plus one mono face, two families maximum. Text is small (the smallest steps of the type scale), sits at the edges over the dark scene with strong contrast, and never covers the centre; the copy never competes with the canvas.

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
