# Frontend Quality Rules

## Never Ship an Empty Page
Every route/page must have meaningful content. If there's no data yet, show
a well-designed empty state (icon or illustration + heading + description + CTA).
A page that is 90% white space is a bug, not a feature.

## Complete the Page
When building a UI, finish every section. Do not build a navbar and stop.
Do not build a layout skeleton and leave the content area empty. Every
visible region must have purposeful content — real components, placeholder
data, or a designed empty/loading state.

## Minimum Visual Quality
- **Spacing:** Use a consistent spacing scale (4px/8px base). Content must
  breathe — no elements touching the viewport edges without padding.
- **Typography hierarchy:** At minimum: heading, subheading, body. Never
  render all text at the same size and weight.
- **Color:** Never use pure #000 on pure #fff as the only palette. Use a
  design system or shadcn theme. At minimum: primary color, muted text,
  border color, background color.
- **Layout:** Content must be centered or constrained to a max-width.
  No full-bleed text paragraphs stretching across the viewport.

## Anti-Scaffold Rules
- If you build a navbar, the page below it MUST have content.
- If you build a sidebar, the main area MUST have content.
- If you build a form wrapper, it MUST have form fields.
- If you build a card or table shell, it MUST have rows or data.
- "Coming soon" is not acceptable. Build a real page.

## Empty & Loading States
Every data-fetching page needs three states:
1. **Loading:** skeleton or spinner with contextual message
2. **Empty:** illustration/icon + message + action button
3. **Error:** message + retry button

## Self-Check Before Finishing
Before declaring a UI task done, ask: "If a user opened this page right
now, would they see anything useful?" If the answer is no, keep building.
