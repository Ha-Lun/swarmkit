---
name: frontend-design-baseline
description: Reference for the foundational design disciplines — typography, color, layout, motion, depth, and surfaces. Loaded by premium-frontend-system as the underlying knowledge layer. Do not use as a standalone working skill; use premium-frontend-system for that.
---

# Frontend Design Baseline

The disciplines a senior frontend practitioner has internalized. This skill is a reference layer, not a workflow. The workflow lives in `premium-frontend-system`.

Use this skill to look up principles quickly. Use the main skill to apply them.

---

## 1. Typography

Typography is the loudest design decision on a page. Most AI-generated UI gets this wrong by picking a font instead of building a *type system*.

### Anatomy that matters
- **x-height** — high x-height reads as modern, neutral, friendly
- **Contrast** — high-contrast (thin/thick) serifs feel editorial; low-contrast grotesques feel neutral
- **Aperture** — open apertures read better at small sizes
- **Terminals** — angled terminals feel humanist; flat terminals feel geometric

### Building a type system
A system has roles, not fonts:

| Role       | Purpose                                     | Notes                                      |
|------------|---------------------------------------------|--------------------------------------------|
| Display    | Hero, brand moments, oversized type          | One weight. Often variable. Tight tracking |
| H1 / H2    | Page / section titles                       | One weight per role                        |
| H3 / H4    | Sub-sections, card titles                   | One weight per role                        |
| Body       | Paragraphs, descriptions                    | Optimized for reading. Loose leading       |
| Caption    | Metadata, timestamps, fine print             | High x-height. Slightly tighter leading    |
| Mono       | Code, technical data, ID strings            | Optional. Useful in product / dev tools    |

### Type rules
- **Two families, three weights, max.** More is a system that doesn't exist.
- **Pairing logic**: if display is serif, body is sans. If display is sans bold, body is sans regular. Never two displays.
- **Tracking**: display is tight (-1% to -3%), body is neutral, caption is slightly open (+1% to +2%).
- **Leading**: body 1.5–1.7, display 0.95–1.1, caption 1.3–1.4.
- **Measure**: 50–75 characters per line for body. Wider is unreadable.

### Anti-patterns
- Inter for everything, with a "heading variant"
- Custom fonts for brand presence that don't perform
- Mixing three weights in one section
- Tracking loose on display, tight on body
- Using a script / handwriting font for UI labels

---

## 2. Color

A color system is built on a *philosophy*, not a palette generator.

### Color philosophies
- **Monochrome editorial** — one hue, five to seven stops. Maximum commitment, single accent.
- **Restrained neutral + one accent** — paper / ink surfaces, a single saturated accent for action.
- **Duotone** — two opposing hues at full strength. Light / dark surface duality.
- **Deep saturated** — dark mode is the default; accents are vivid. Premium when restrained.
- **Earth / analog** — warm neutrals, ink black, single warm accent. Feels physical.

### Token structure
Build a token system, not a palette file.

```
bg            — page background
surface       — cards, elevated panels
surface-2     — nested surfaces, hover
border        — dividers, low-emphasis
text          — primary text
text-muted    — secondary text
text-faint    — tertiary, metadata
accent        — primary action, emphasis
accent-fg     — text on accent
danger        — errors
success       — confirmation
warning       — caution
focus         — keyboard focus ring
```

Both light and dark themes map to the same token names. Only values change.

### Contrast
- Body text on background: 4.5:1 minimum (WCAG AA)
- Large text (18pt+ / 14pt bold+): 3:1 minimum
- UI components (icons, borders indicating state): 3:1
- Never communicate state with color alone. Use icon + text.

### Anti-patterns
- The AI purple-to-blue gradient on white
- Low-contrast gray on gray (so common it's a meme)
- Pure black (`#000`) text on pure white — use a near-black, e.g. `#0A0A0A`, for less eye strain
- Pastel-on-pastel
- Six accents in one section

---

## 3. Layout & composition

The grid is the personality of the page.

### Grid systems
- **12-col** — flexible, standard, works for product and marketing
- **8-col / 16-col** — denser, more editorial
- **Modular bento** — visibly varied cell sizes, asymmetric
- **Single column** — scroll storytelling, long-form
- **Magazine spread** — mixed densities, multiple type sizes per page

### Composition rules
- **Asymmetry is a feature.** Centered-everything is a shrug.
- **One strong axis.** Either vertical (storytelling) or horizontal (split-screen / two-up). Mixing them in one viewport reads as indecisive.
- **Whitespace is hierarchy.** More space = more importance. Don't be afraid of empty.
- **Optical alignment over geometric alignment.** A 12-col grid is for layout, not the eye. Nudge by 4–8px when the math is right but the eye is wrong.
- **Overlap is allowed and encouraged.** A hero headline that breaks into the next section creates energy.
- **Cropping is allowed.** Type that bleeds off the edge, image that crops a face — both add momentum.

### Density
- **Marketing**: low density, large type, generous whitespace
- **Product**: medium density, table-friendly, scannable
- **Tools / dashboards**: high density, optimized for scanning, no marketing whitespace

Pick a density and own it. Mixing densities in one page reads as confused.

### Anti-patterns
- Centered hero with centered subtitle, centered CTA, centered image
- Three equal columns for "features"
- All cards the same size in a feature section
- Fixed 1200px max-width with no consideration of wider screens
- Perfectly balanced 50/50 splits when the content wants 60/40

---

## 4. Motion

Motion is voice. Pick a language and stick to it.

### Motion languages
- **Restrained reveal** — `translateY(8–16px)` + `opacity 0→1`, 300–500ms, ease-out. Default for product UI.
- **Playful spring** — slight overshoot, spring easing. Use for rewards, state changes, micro-interactions.
- **Mechanical linear** — no easing, stepped. For technical / data-heavy UIs.
- **Cinematic slow** — 800ms+, scroll-driven, deliberate. Hero and editorial only.
- **None** — for accessibility-first, dense dashboards, tools. Valid choice.

### Properties to animate
- `transform` (translate, scale, rotate)
- `opacity`
- `filter` (sparingly, expensive)
- `background-color`, `color`, `border-color` (for state changes only)

### Properties to never animate
- `width`, `height` (use `transform: scale` instead)
- `top`, `left`, `right`, `bottom` (use `transform: translate` instead)
- `padding`, `margin` (layout shifts kill performance)
- `box-shadow` blur radius (expensive)

### Timing
- Hover / state: 150–200ms
- Element enter: 300–500ms
- Page transition: 400–600ms
- Hero / editorial: 800ms+

### Easing
- `ease-out` (cubic-bezier(0, 0, 0.2, 1)) — most UI
- `ease-in-out` — symmetrical transitions
- `cubic-bezier(0.16, 1, 0.3, 1)` — premium ease, used in motion design
- `linear` — mechanical, data, progress
- Spring — playful, rewarding

### Reduced motion
Always honor `prefers-reduced-motion: reduce`. Replace transitions with instant state changes. Replace large translates with subtle opacity shifts. Replace parallax with no movement. This is not a fallback — it is the user-requested experience.

### Anti-patterns
- `transition: all 0.3s ease` (the default of AI styling)
- Animating every element on page load
- Auto-playing ambient loops on long-form content
- Scroll-jacking
- Animations that block the user from doing the next thing

---

## 5. Depth

How does the UI express depth?

### Strategies
- **Flat** — borders only, sharp type, brutalist / editorial
- **Layered cards** — soft large-radius shadows, 1–2 elevation levels
- **Glass** — `backdrop-filter: blur()`, low-opacity surfaces, used sparingly
- **Real 3D** — model-driven depth, justifies itself
- **Mixed** — default for most projects. Define the rule and the exception.

### Shadow recipes
- **Soft elevation**: `0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)`
- **Lifted**: `0 4px 8px rgba(0,0,0,0.04), 0 16px 32px rgba(0,0,0,0.08)`
- **Sharp / editorial**: `0 1px 0 rgba(0,0,0,0.08)` (a hairline, not a glow)
- **Colored glow** (use rarely): `0 0 0 1px rgba(color,0.5), 0 8px 32px rgba(color,0.3)` — for hero moments only

### Rules
- Shadows are not a replacement for borders
- Dark mode shadows need different values — black-on-dark is invisible. Use lighter shadows, or borders.
- Never more than two elevation levels per view

### Anti-patterns
- Heavy shadows on every card
- Neon glows on every element
- Glass on every surface
- Inconsistent shadow scales across the page

---

## 6. Surfaces & details

The small decisions that separate premium from generic.

### Corner radius
Pick a scale: 0, 2, 4, 8, 12, 16, 24, 999 (pill). Use it consistently.
- **Sharp / brutalist**: 0–2
- **Editorial / refined**: 4–8
- **Friendly / product**: 12–16
- **Pill**: 999 for tags, avatars, soft buttons

### Border weight
Pick a scale: 0, 1, 2. Use it. Avoid 1.5.

### Iconography
- Pick a system: Lucide, Phosphor, Heroicons, Tabler. Don't mix.
- Use one stroke weight and one size scale across the product
- Icons in headings: same size as the cap-height, not the line-height
- Icons in buttons: 16–20px

### Imagery
- Real photography > stock > AI-generated, in that order
- Image treatment: same filter / grade across a project
- Aspect ratios: pick 3–4, use them consistently (16:9, 4:3, 1:1, 3:4, 9:16)

### Grain / noise
- Use only on hero moments
- One noise texture across the project
- Never on body content (kills legibility)

---

## 7. Dark mode parity

Dark mode is not a CSS invert. It is a second theme with the same token names.

### Rules
- Both themes share the token system; only values change
- Pure black (`#000`) is rarely right — use `#0A0A0A` or `#0E0E10` for less contrast strain
- Pure white text on dark backgrounds is also wrong — use a near-white, e.g. `#EDEDED`
- Imagery must work in both, or be theme-aware
- Shadows in dark mode: use lighter shadows (e.g. `rgba(255,255,255,0.05)`) or borders instead
- Test both themes at every breakpoint
