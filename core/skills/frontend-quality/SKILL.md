---
name: frontend-quality
description: Use when evaluating or improving frontend code — component architecture, accessibility (WCAG 2.2 AA), responsive design, state management, performance, and frontend testing. Loaded by the frontend-specialist agent.
---

# Frontend Quality

Standards and checklist for frontend code quality evaluation.

## Component architecture

- Single responsibility: each component does one thing. If a component has multiple unrelated responsibilities, extract sub-components.
- Props interface: use TypeScript interfaces for props. Avoid `any`. Use discriminated unions for variant props.
- Composition over configuration: prefer `children` and render props over bulky config objects.
- Hooks discipline: `useCallback` and `useMemo` only when there is a measured performance need. Dependencies arrays must be complete.
- No prop drilling beyond 3 levels — use context, but keep context scope narrow to avoid unnecessary re-renders.

## Accessibility (WCAG 2.2 Level AA)

- Semantic HTML: use `<nav>`, `<main>`, `<aside>`, `<section>`, `<article>`, `<header>`, `<footer>` correctly.
- Headings: hierarchical `h1`-`h6`, no skipping levels.
- Alt text on every `<img>`. Decorative images get `alt=""`.
- ARIA: use when native semantics are insufficient. Do not override native semantics unnecessarily.
- Keyboard: all interactive elements reachable and operable via keyboard. Visible focus indicators.
- Color contrast: 4.5:1 for normal text, 3:1 for large text (18px bold or 24px regular).
- Forms: labels associated with inputs, error messages linked via `aria-describedby`.
- Motion: `prefers-reduced-motion` respected for animations.
- Touch targets: minimum 44x44px on mobile.

## Responsive behavior

- Test at breakpoints: 320px, 480px, 768px, 1024px, 1440px.
- No horizontal overflow at any viewport width.
- Touch targets sized and spaced for finger interaction.
- Fonts use relative units (`rem`, `em`) — no fixed `px` for text sizes unless intentional.
- Images use `max-width: 100%` and `height: auto` unless aspect-ratio controlled.

## State management

- State locality principle: start local, lift only when needed.
- Avoid putting derived data in state — compute it from source state.
- Selectors: memoize with `useMemo` or a selector library (Reselect, Zustand).
- Immutable updates: do not mutate state objects directly.
- Stale closure: verify that `useEffect`, `useCallback`, and event handlers reference current values.

## Performance

- Bundle size: avoid large imports. Use dynamic `import()` for route-level code splitting.
- Re-renders: memoize expensive child components with `React.memo` when parent re-renders frequently.
- Lists: stable `key` props (not array index for dynamic lists).
- Images: lazy loading (`loading="lazy"`), responsive images with `srcSet`, proper dimensions to prevent layout shift.

## Testing

- Test user behavior, not implementation details.
- Cover: render, user interaction, loading state, empty state, error state, edge cases (long text, missing data).
- Avoid snapshot tests that cover entire large components — they break too easily.
