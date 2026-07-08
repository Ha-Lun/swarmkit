---
name: design-taste-frontend
description: Reference for the taste and anti-slop discipline. Loaded by premium-frontend-system to enforce what separates premium frontend work from generic AI output. Do not use as a standalone working skill; use premium-frontend-system for that.
---

# Design Taste — Frontend

The discipline of restraint. The set of judgments that separates premium frontend work from generic AI output. This skill is a reference layer, not a workflow. The workflow lives in `premium-frontend-system`.

The most common cause of generic-looking UI is not bad code. It is the absence of a point of view.

---

## 1. Read the brief before you read the codebase

Most generic UI is generated before the brief is understood. The fix is to read first, then design, then code. The order is the discipline.

### Questions the brief must answer

If any of these are unclear, stop and surface the gap. Do not invent.

1. **Who is the user, specifically?** Not "users." A person. A role. A context.
2. **What are they trying to do, in their words?**
3. **What should they feel while doing it?** One feeling, not five.
4. **What is the brand's voice?** Editorial, technical, playful, authoritative, rebellious, tender, clinical. Pick one.
5. **What is the brand fighting against?** Every premium brand is a reaction. "We're not another X." Name it.
6. **What are the hard constraints?** Browser, performance, no-3D, existing brand, no-build, dark-first.
7. **What is the single most important thing the user should see in the first 3 seconds?**

If you can answer all of these, you can design. If you cannot, you will produce generic.

---

## 2. The generic-AI look — what it is and how to escape it

### The tells

You can spot AI-generated UI from across the room:

- Hero is a centered title, centered subtitle, centered CTA, on white
- The hero has a faint purple/blue gradient blob in the background
- A "trusted by" logo strip directly under the hero
- Three columns of icon + heading + paragraph for features
- Five-star testimonials in a row of three cards
- Pricing table with three tiers, "Pro" highlighted, checkmark lists
- A footer with six columns of links
- Primary color is one of: indigo-500, violet-500, blue-500, sky-500
- The motion is `transition: all 0.3s ease`
- The whole thing could be the homepage of literally any SaaS

### Why it happens

Because the model has been trained on the median of the web, and the median of the web is this. To escape the median, you have to **commit to a direction that is not the median**.

### How to escape

1. **Pick a typographic system, not a font.** Two families, three weights, a real hierarchy.
2. **Pick a color philosophy, not a palette.** Commit to a single approach.
3. **Pick a layout personality, not a template.** Asymmetric editorial, magazine spread, vertical storytelling, bento, brutalist, dense product.
4. **Pick a motion language, not transitions.** One voice, applied consistently.
5. **Remove the tropes.** If a section is the same as every other SaaS, redesign it from first principles.
6. **Show restraint.** A premium site removes more than it adds. The most expensive thing is saying no.

---

## 3. Anti-slop rules

These are not suggestions. They are bans. Violating them is a failure of the work.

### Layout slop
- Centered-everything hero
- Three-column feature grid with equal cards
- "Trusted by" logo strip without context
- Five-star testimonial cards
- Three-tier pricing with "Pro" highlighted
- Six-column footer
- Dashboard mock as the hero image

### Aesthetic slop
- The AI purple/blue gradient on white
- Floating gradient blobs in the background
- Glassmorphism on every surface
- Emoji as icon
- Lottie animation that loops forever
- Background video with sound
- Neon glows on standard UI elements

### Code slop
- `transition: all 0.3s ease`
- Magic numbers (random px values not on a scale)
- Inline `style={{}}` for things that repeat
- Untyped component props
- Unnecessary `"use client"`
- Three icon libraries mixed in one project
- A copy-paste component with a different name in every section

### Motion slop
- Animating every element on page load
- Looping ambient animations
- Auto-playing background video
- Parallax that doesn't add meaning
- Scroll-jacking
- Animations that delay the user from doing their task

### 3D slop
- 3D model in a form
- 3D model on a settings page
- 3D model "for visual interest" with no narrative purpose
- 3D model that loads in the critical path
- 3D model with no 2D fallback
- 3D model with no reduced-motion fallback

---

## 4. The taste test

Before declaring any UI section done, run it through these questions:

1. **Could this section appear on any other SaaS site, unchanged?** If yes, redesign.
2. **If I removed the gradient / the icon / the animation, would anyone notice?** If no, remove it.
3. **Is there a moment on this page I would show a friend?** If no, the page has no character.
4. **Does the type hierarchy make the page scannable in 3 seconds?** If no, fix the type.
5. **Is the motion doing work, or is it decoration?** If decoration, remove or repurpose.
6. **Would a senior design engineer approve this in a portfolio review?** Be honest.

The taste test is not a checklist for "passing." It is a forcing function for honesty. Most generic UI fails on question 1.

---

## 5. Restraint is the design

The hardest thing in design is saying no. Adding a feature, an animation, a section, a color is easy. Removing one is hard. The premium look comes from what is not there.

### Restraint in type
- Two families. Not three. Not "one for headers and a fallback."
- Three weights. Not five.
- One accent color. Not two.

### Restraint in motion
- One motion language per project.
- One load animation. Not one per section.
- Reduced motion is honored, not faked.

### Restraint in color
- A philosophy, fully committed.
- The accent color is rare, so it has weight.
- Neutrals do the heavy lifting.

### Restraint in layout
- Empty space is a feature.
- One asymmetric hero, not a centered one with "design energy" sprinkled on.
- Density is chosen for the content, not the template.

### The test
If a section is "fine" but unremarkable, it is not done. It is generic. Generic is failure. Keep iterating until the section is **specific** — specific to this product, this user, this feeling.

---

## 6. 3D — the discipline of "do we actually need this"

3D is expensive. It costs performance budget, complexity, accessibility work, and cognitive load. The cost is justified only when the value is real.

### 3D pays off when
- The product is a physical object that benefits from rotation, configuration, or demonstration
- The user is choosing between visual variants (color, material, size)
- The 3D is a brand-defining moment (Apple, Linear, Vercel-tier)
- The product is spatial by nature (architecture, real estate, design tools)

### 3D does not pay off when
- The page is a dashboard
- The page is a form
- The page is a settings page
- The 3D is just decoration
- The 3D is in the critical render path
- The 3D has no reduced-motion fallback
- The 3D has no 2D fallback
- The 3D slows the perceived load of the page

### 3D implementation discipline
- Lazy-load the 3D bundle — never in the critical path
- Provide a poster image while loading
- Optimize aggressively (Draco, texture atlasing, polygon budget)
- Provide a 2D fallback for `prefers-reduced-motion` and low-power devices
- Test on a mid-range mobile, not your development machine
- If the 3D can be replaced with a still image and the page is just as good, replace it

---

## 7. Dark mode is a design discipline, not a toggle

A dark mode toggle is not the same as dark mode design. Toggles can be added. Design must be considered.

### What dark mode requires
- A complete token mapping for every theme
- Imagery that works in both themes
- Form components re-checked for contrast and focus visibility
- Shadows re-tuned (black shadows are invisible on dark)
- Brand accents verified for accessibility in both
- Both themes tested at every breakpoint, every state
- Reduced-motion behavior verified in both

### What dark mode is not
- A `filter: invert()` applied at the root
- A pure black background with pure white text
- An after-the-fact color flip

---

## 8. The taste of motion

Motion is voice. The wrong motion can ruin a good design faster than anything else.

### The voice match
- **Restrained reveal** for product UI (calm, confident)
- **Playful spring** for consumer, reward, state-change moments
- **Mechanical linear** for technical tools, data UIs, dev tools
- **Cinematic slow** for marketing hero, brand storytelling
- **None** for accessibility-first, dense dashboards

### The failure modes
- **Animation as filler** — every element animates, nothing is special
- **Animation as distraction** — the user is trying to do something, the animation gets in the way
- **Animation as surprise** — random easings, no logic, the user feels manipulated
- **Animation as a tax** — long durations, no purpose, slow page

### The discipline
- One motion language per project
- Every animation has a job (reveal, state change, hierarchy, attention)
- `prefers-reduced-motion` is honored — fully, not partially
- Hover, focus, and active states are designed, not defaulted

---

## 9. The portfolio test

Before declaring any frontend work done, ask:

> Would I put this in a portfolio with my name on it?

Not "is it functional." Not "does it pass QA." Would I claim it?

If the answer is no, the work is not done. Iterate. Remove. Restructure. Commit to a direction. Be specific. Be restrained. Be opinionated.

Generic is failure. Specific is success.
