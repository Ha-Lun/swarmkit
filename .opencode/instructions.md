# Chrome-Devtools Usage Guidelines

To minimize token usage, follow these rules when using chrome-devtools MCP:

## Avoid includeSnapshot:true unless necessary
- Default behavior: DO NOT pass `includeSnapshot: true` to click(), fill(), hover(), drag(), etc.
- Only use `includeSnapshot: true` when you specifically need to read the page state after the action
- Most interactions don't need the snapshot - just verify the action succeeded

## Be selective about verbose tools
- `list_network_requests`: Only call when debugging network issues. Use `resourceTypes` filter when possible.
- `list_console_messages`: Only call when debugging console output. Use `types` filter when possible.
- `take_snapshot`: Use sparingly. Prefer `take_screenshot` for visual verification.
- `get_network_request` / `get_console_message`: Fetch individual items instead of listing all.

## Prefer screenshots over snapshots for verification
- Use `take_screenshot` to visually verify UI state (returns image, less token-heavy than full a11y tree)
- Use `take_snapshot` only when you need to read specific element text/attributes

## Batch form interactions
- Use `fill_form` instead of multiple `fill` calls when filling multiple fields

## Close pages when done
- Use `close_page` to clean up browser tabs after testing

# Planning Standards — Reference Sites

Any implementation plan presented for approval that dispatches `frontend-specialist` or `animation-specialist` MUST include an explicit **Reference sites** subsection. This applies to both the user-facing plan (workflow §5) and the subagent handoff prompt (workflow §7).

## Plan section (user-facing)

Include a `**Reference sites**` block listing:

1. Each URL/source the specialist will use (Figma, live site, screenshot, brand guide, mood board, etc.).
2. Which specialist uses each reference, and for what (layout/typography, palette, motion choreography, etc.).
3. The fallback when no reference exists — named explicitly (existing project design tokens / specialist's curated library / user-provided verbal description), per the frontend reference check.
4. Offer a screenshot when the reference is a live site or Figma frame where a picture conveys more than a URL. Ask before embedding to keep the plan lean unless visuals matter.

## Subagent handoff (specialist-facing)

Reproduce the reference list verbatim in a `References:` block at the top of every handoff to `frontend-specialist` or `animation-specialist`, so the specialist has it in-context and cannot drift:

    References:
    - [URL] → used by [agent] for [purpose]
    - [URL] → used by [agent] for [purpose]

## Scope

- Triggered whenever a plan involves visual work by `frontend-specialist` or `animation-specialist` (landing pages, marketing sites, dashboards, redesigns, new page designs, motion work).
- Skipped for bug fixes, styling tweaks, or accessibility improvements to existing pages where the visual language already exists and no new reference is needed.

# Agent Behavior: Doer, Not Advisor

When presenting findings, fixes, or next steps, agents must frame their output as actions they will perform — not homework for the user. Say "here's what I'll do — should I proceed?" instead of "here's what you should do." Agents have the tools to execute; use them.

# Sudo & Destructive Operations Policy
 
Whenever sudo is needed for something destructive — removing files, altering system configuration, security-sensitive changes, or other permanent changes — the exact command(s) must be brought up in the plan presented to the user, so the user sees exactly what will run before approving. Non-destructive sudo usage (e.g. reading logs) does not require plan surfacing.

# Dev Server Binding & Tailscale Network Policy

- **Host Binding**: All dev servers and local services created or started on this machine must bind to `0.0.0.0` or `127.0.0.1` (e.g. `vite --host 0.0.0.0`, `uvicorn --host 0.0.0.0`, `next dev -H 0.0.0.0`).
- **URL References**: All dev server URLs, API test endpoints, links, browser test targets, and user messages must reference `http://localhost:<port>` or `http://127.0.0.1:<port>`.

