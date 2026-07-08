---
name: premium-frontend-system
description: Premium frontend implementation system. Use for any non-trivial frontend work — pages, components, design systems, marketing sites, product UI, motion, and 3D. Establishes design direction before code, enforces anti-slop rules, demands production-ready output, and treats restraint as a feature. Load this skill by default for frontend implementation tasks.
---

# Premium Frontend System

A working system for shipping frontends that look and feel like a senior design engineer made them. Not a mood board. Not a component library. A discipline.

The default failure mode of AI-generated UI is generic. This skill exists to break that default. It is opinionated, brief-first, and production-bound.

## When to use this skill

- New pages, sections, components, or full sites
- Marketing sites, landing pages, product UI, dashboards, editorial layouts
- Design system work — tokens, primitives, component APIs
- Motion design, micro-interactions, scroll storytelling
- 3D / WebGL for product showcases or premium hero work
- Refactors that touch visual identity or layout system

Do **not** use this skill for:
- Pure backend, data, or API work
- Trivial styling tweaks that don't change the design language
- One-off bug fixes (use the regular frontend workflow)

---

## Phase 1 — Read the brief like a designer

Before a single line of code, answer these in writing. If you cannot answer them, the brief is incomplete — ask.

1. **Who is this for?** A specific human, not "users." An indie hacker? A design director at a Fortune 500? A 22-year-old creator? The answer changes everything.
2. **What is the one thing they should feel?** Not three things. One. ("Confident restraint." "Cinematic anticipation." "Quiet competence.")
3. **What is the product's voice?** Editorial / Technical / Playful / Authoritative / Rebellious / Tender / Clinical. Pick one and commit.
4. **What is the brand fighting against?** Every premium brand is a reaction to something. "We're not another SaaS dashboard." "We're not a generic AI wrapper." Name it.
5. **What are the constraints?** Browser support. Performance budget. No-3D. Existing brand. No-build. Dark-mode-first. Be honest.

If any of these are missing, stop. Surface the gap to the orchestrator. Do not invent answers silently.

---

## Phase 2 — Commit to a design direction

A design direction is a small set of opinionated choices that bind the whole project. Define them explicitly before implementation. Five to seven is enough. More than ten and the system is incoherent.

Required direction choices:

### Typography personality
Pick a real typographic system. Not "Inter and a heading font." A *system*.

- **Editorial / heritage**: A high-contrast serif display (e.g. Fraunces, GT Sectra, Tiempos) paired with a humanist sans for body. Generous leading. Tight tracking on display, loose on body.
- **Modern product**: A neutral grotesque (Inter, Söhne, General Sans) with a sharp display face for hero moments. Tabular numerals in data.
- **Technical / developer**: A monospace (JetBrains Mono, Berkeley Mono) for accents, paired with a calm grotesque. Code is a first-class citizen.
- **Maximalist / brand-led**: A bold display (Söhne Breit, Tobias, Söhne Mono) as the lead voice, with everything else as support.

Rule: **two families, three weights total, max**. Anything more is a system that doesn't exist.

### Color philosophy
Pick a philosophy, not a palette.

- **Monochrome editorial** — one hue at five to seven stops. High contrast. One accent only used for action.
- **Restrained neutral + one accent** — paper-like neutrals, a single saturated accent for moments of emphasis.
- **Duotone bold** — two opposing hues at full commitment. Light/dark dual surfaces.
- **Deep saturated** — dark surfaces, vivid accents, neon-bright CTAs. Premium when done with restraint.
- **Earth / analog** — warm neutrals, ink black, single warm accent. Feels physical.

**Banned**: the "AI gradient" — purple-to-blue, indigo-to-cyan, on white, on a hero, with a glow. If your first instinct is a purple/blue gradient, stop and reconsider the brand.

### Layout system
The grid is the personality.

- **Asymmetric editorial** — 12-col grid with a clear bias to one side. Large whitespace pockets. Headlines often left-aligned and far from the optical center.
- **Magazine spread** — wide hero, dense text columns, mixed type sizes, real hierarchy.
- **Vertical storytelling** — single column, large type, scroll-driven reveals, one idea per screen.
- **Bento / modular** — clean grid of differently-sized cards. Works for product feature showcases.
- **Brutalist / structural** — visible grid, raw type, sharp corners, intentional tension.
- **Dense product** — table-first, tight rhythm, no marketing whitespace. Dashboards live here.

**Banned**: centered-everything layouts. Centered hero, centered text, centered CTA, centered everything. Centered layouts are the visual equivalent of shrugging.

### Motion language
Motion is voice. Pick one:

- **Restrained reveal** — elements enter with subtle 8–16px translate + opacity, 300–500ms, ease-out. Default for product UI.
- **Playful bounce** — spring easing, slight overshoot, used for state changes and rewards.
- **Mechanical precision** — linear or stepped easing, no overshoot, used for technical or data-heavy UIs.
- **Cinematic slow** — 800ms+ reveals, scroll-driven, used for hero and editorial moments only.
- **None** — for tools, dense dashboards, accessibility-first contexts. This is a valid choice.

Rule: **one motion language per project**, not one per component. Consistency is the design.

### Depth strategy
How does the UI express depth?

- **Flat** — no shadows, borders only, sharp type. Brutalist / editorial.
- **Layered cards** — soft, large-radius shadows, 1–2 elevation levels.
- **Glass** — backdrop-blur, low-opacity surfaces, used sparingly. Easy to overdo.
- **Real 3D** — model-driven depth. See the 3D section.
- **Mixed** — most projects. Pick a default and define the exceptions.

### Surface treatment
Decide and commit:

- Corner radius (0 / 2 / 8 / 12 / 16 / 24 — not "various")
- Border weight (0 / 1 / 2 — not 1.5)
- Shadow style (none / soft / sharp / colored)
- Grain or noise (yes / no / only in hero)

---

## Phase 3 — Map to a real system before coding

Translate the direction into tokens, primitives, and components. **Do not start with pages.** Build the system, then the page consumes the system.

### Tokens (define these first)
- Color: 8–12 named tokens, semantic mapping (`bg`, `surface`, `text`, `text-muted`, `border`, `accent`, `accent-fg`, `danger`, `success`, `warning`)
- Type: 5–7 type roles (`display`, `h1`, `h2`, `body`, `caption`, `mono`)
- Space: 4px or 8px base scale, 6–8 named steps
- Radius: 2–4 named steps
- Motion: 3–4 named durations, 2–3 named easings
- Breakpoints: 3–4 max

### Primitives (build these second)
- `Box`, `Stack`, `Cluster`, `Grid` — layout primitives
- `Text` — type role wrapper
- `Button`, `Input`, `Select`, `Checkbox`, `Switch` — form primitives
- `Card` — surface primitive
- `Icon` — icon wrapper with consistent stroke and size

### Components (third)
- Header, Footer, Nav
- Hero, Feature, Section, CTA
- Form patterns, Modal, Toast, Tooltip
- Whatever the product needs beyond the above

Pages come last. A page is a composition of components. A component is a composition of primitives. A primitive consumes tokens. The system flows down.

---

## Phase 4 — Build with discipline

### Component rules
- One component, one responsibility. If the name needs "And" in it, split it.
- Props are typed. Variants are explicit (`variant="primary" | "secondary" | "ghost"`), not booleans.
- No prop drilling past two levels. Lift or use context.
- Composition over configuration. `Card.Body`, `Card.Footer` over a `Card` with 8 props.
- Server and client boundaries are explicit. Default to server. Mark `"use client"` deliberately.

### Styling rules
- Use the token system. No raw hex values in components.
- Tailwind: keep it. Map your tokens to Tailwind theme. Don't fight the cascade with `@apply` everywhere.
- CSS Modules / vanilla-extract / styled-components: pick one, not two.
- No `!important` unless overriding a third-party stylesheet.
- No inline styles for anything that has visual rhythm. Inline is for one-offs only.

### State rules
- Local state stays local. Lift only when siblings need it.
- Global state is for global state. Don't put form state in Redux.
- Selectors are memoized. Re-renders are earned, not accidental.
- Loading, error, and empty states are not afterthoughts. They are part of the design.

### Motion implementation
- Honor `prefers-reduced-motion`. Always. The transition is "no transition."
- Animate `transform` and `opacity`. Never `width`, `height`, `top`, `left`.
- Use `will-change` sparingly. It is a hint, not a default.
- Scroll-driven animations: use the View Transitions API or `IntersectionObserver`, not jank.
- Never animate the entire page on every scroll. Stagger, then stop.

### 3D implementation
See the dedicated section below.

---

## Phase 5 — Validate before delivery

Use the delivery checklist at the end of this skill. Run it as a literal pass/fail gate. If a check fails, fix it before declaring done. No "we can fix it later" — there is no later.

---

## Anti-pattern bans (hard rules)

These are not preferences. They are bans. If you ship any of them, you have failed the brief.

### Banned layouts
- **Generic SaaS feature grid** — three columns of icon + heading + paragraph + button, repeated. This is the "I gave up" layout.
- **Centered-everything hero** — title, subtitle, button, all center-aligned, on a white background, with a stock illustration. Replace with an asymmetric editorial hero or a left-aligned type-led hero.
- **Decorative blobs** — floating gradient orbs in the background of a hero, doing nothing, just glowing. Banned. If a gradient is on screen, it is doing work (atmosphere, hierarchy, depth).
- **Dashboard wallpaper** — a hero that looks like a dashboard. If you want to show a product, show a real surface, not a fake one.
- **Three-card testimonial row** — five stars, headshot, quote, name. The cliche of social proof. Use editorial pull-quotes or a single large voice instead.

### Banned aesthetics
- **The AI purple/blue gradient** — `#6366F1` to `#8B5CF6` on a hero, often with a glow. Banned.
- **Generic glassmorphism** — `backdrop-blur` on everything, with low-opacity white. Easy to overdo. Use glass for one moment, not the whole page.
- **Emoji as icon** — 🚀, ⚡, ✨ in headings. Banned in production UI. Use a real icon set (Lucide, Phosphor, Heroicons).
- **Lottie-as-decoration** — animations on every section to "add life." Banned unless the animation is doing work.

### Banned code patterns
- **`transition: all 0.3s ease`** — the default of AI styling. Specify properties. Specify duration. Specify easing.
- **Inline `style={{}}` for things that recur** — extract to a token.
- **Magic numbers** — `padding: 13px`. Round to the scale.
- **Untyped props** — `any` is a smell. Type everything.
- **Unnecessary `"use client"`** — every client component is a cost. Default to server.
- **Unused imports / dead code** — leave nothing behind.

### Banned motion
- **Animation spam** — every element bouncing, fading, sliding, on load. Pick a load state. One.
- **Scroll-jacking** — overriding native scroll behavior. Banned.
- **Looping ambient animation on long-form content** — distracting, costly, banned.
- **Auto-playing video with sound** — banned.

---

## Production requirements (non-negotiable)

Every frontend deliverable must satisfy these. They are not nice-to-haves.

### Semantic HTML
- One `<h1>` per page, descending hierarchy
- `<main>`, `<nav>`, `<header>`, `<footer>`, `<aside>`, `<section>`, `<article>` used correctly
- Lists for lists, buttons for actions, links for navigation
- Forms: `<label for>`, `<fieldset>`, error states tied to `aria-describedby`

### Accessibility (WCAG 2.2 AA minimum)
- Keyboard navigation works for every interactive element
- Focus visible at all times — never `outline: none` without a replacement
- Color contrast: 4.5:1 for body text, 3:1 for large text and UI components
- Touch targets ≥ 44×44px on mobile
- `prefers-reduced-motion` honored for every animation
- No accessibility violations from `axe-core` or equivalent
- Screen reader landmarks present and labeled

### Responsive
- Mobile-first or desktop-first — pick one, be consistent
- Test at: 320, 375, 640, 768, 1024, 1280, 1536 (whichever are in scope)
- No horizontal overflow at any breakpoint
- Type scales fluidly (`clamp()` is your friend)
- Layouts collapse gracefully — never break, just rearrange

### Performance
- LCP < 2.5s on a 4G connection
- CLS < 0.1
- TBT / INP in the green
- Images: `next/image` or equivalent, modern formats, explicit dimensions
- Fonts: subset, preload, `font-display: swap`
- JS bundle: route-level code splitting
- No render-blocking third-party scripts in the critical path

### Dark mode
- If the product has dark mode, treat it as a first-class theme, not an afterthought
- Both themes share the same token names; only the values change
- Test both themes at every breakpoint
- Imagery must work in both (or be theme-aware)

### State feedback
- Every interactive element has visible `:hover`, `:focus-visible`, and `:active` states
- Buttons feel like buttons on press (subtle transform, color shift)
- Form fields show validation state (error / success) with more than color (icon + text)
- Loading states are designed, not just spinners

---

## 3D — when to use it, when not to

3D is a commitment. It costs performance, complexity, accessibility work, and cognitive load. Use it when the value is real.

### Appropriate for 3D
- **Product showcases** — a physical product rendered in 3D, rotated, configured. The 3D is the product.
- **Device visualization** — a phone/laptop/headset showing the product in its native habitat.
- **Premium hero storytelling** — a single, slow, deliberate 3D moment that anchors a landing page.
- **Spatial product demos** — a configurator, a 3D modeler, an architectural walkthrough.
- **Brand-defining moments** — when the 3D is the brand, not decoration (Apple, Linear, Vercel-tier moments).

### Not appropriate for 3D
- **Dashboards** — dense data does not benefit from 3D. Banned.
- **CRUD interfaces** — adding 3D to a form or table is a tax. Banned.
- **Forms** — distraction, slower input, accessibility issues. Banned.
- **Settings pages** — banned.
- **Internal tools** — banned.
- **Anywhere it is decoration** — if you can remove the 3D and the page still works, it was decoration. Remove it.

### 3D implementation rules
- Use a real engine: `react-three-fiber`, `three.js`, `<model-viewer>`, or a hosted solution
- Lazy-load the 3D bundle — never in the critical path
- Provide a 2D fallback for `prefers-reduced-motion` and low-power devices
- Provide a poster image while loading
- Optimize the model: Draco compression, texture atlasing, polygon budget
- Test on mid-range mobile, not just your M3 MacBook
- Always offer an alternative path (a 2D image, a video, a static product shot)

---

## Delivery checklist (run before declaring done)

Tick every box. If you cannot, the work is not done.

### Design fidelity
- [ ] Design direction was defined in writing before code
- [ ] The page commits to typography — not just "a font"
- [ ] Color philosophy is consistent across the page
- [ ] Layout system is followed — no one-off grid hacks
- [ ] Motion language is consistent — no mixed easing languages
- [ ] No anti-patterns from the ban list are present
- [ ] Dark mode parity is achieved (if dark mode is in scope)

### Production readiness
- [ ] Semantic HTML throughout
- [ ] WCAG 2.2 AA: contrast, keyboard, focus, targets all pass
- [ ] `prefers-reduced-motion` honored
- [ ] Responsive at every in-scope breakpoint, no overflow
- [ ] LCP / CLS / INP within budget
- [ ] Images optimized, fonts preloaded
- [ ] No console errors, no warnings
- [ ] No dead code, no unused imports, no commented-out experiments
- [ ] No secrets, no debug logs, no `TODO` markers in production paths

### Component quality
- [ ] Components are decomposed (single responsibility)
- [ ] Props are typed, variants explicit
- [ ] State locality is correct (no unnecessary globals)
- [ ] Loading, error, and empty states are designed
- [ ] Hover, focus-visible, and active states are visible and intentional

### Code quality
- [ ] Styling uses the token system
- [ ] No magic numbers — values come from the scale
- [ ] No `transition: all` — properties are explicit
- [ ] Server/client boundaries are correct
- [ ] 3D (if used) is justified, lazy-loaded, accessible, and has a 2D fallback

### Documentation
- [ ] Unusual decisions are commented in code with a brief why
- [ ] Design tokens are documented in the design system file
- [ ] The orchestrator is told what the design direction was, in one paragraph

---

## Working principles (last, most important)

1. **Direction before code.** Always.
2. **Restraint is a feature.** The most premium work is what you removed, not what you added.
3. **The system is the product.** A page made of system components is maintainable. A page of one-off layouts is technical debt on day one.
4. **Taste is a discipline, not a talent.** Apply the rules until the rules become instinct.
5. **Production beats demo.** If it does not ship clean, it does not ship.
6. **Anti-slop is a habit.** When in doubt, ask: "Would a senior design engineer approve this?" If the answer is "it looks like every other AI site," restart.
