---
name: swarm-handoff
description: Use when coordinating multi-agent workflows, passing context between specialist agents, or structuring handoff documentation between agents in a development swarm. The only skill used by the lead-dev orchestrator.
---

# Swarm Handoff

Structured handoff protocol for agent-to-agent coordination in a multi-agent development swarm.

## Handoff document template

When one agent passes work to another, include these sections:

### Objective
Single sentence describing what the receiving agent should accomplish.

### Files inspected
Paths of files the sending agent examined, with a one-line summary of each.

### Files changed
Paths of files the sending agent modified, with a brief description of each change.

### Assumptions
Explicit assumptions made by the sending agent that the receiver should be aware of. Examples:
- "This service is deployed behind a reverse proxy that terminates TLS."
- "The database migration has already been applied in staging."
- "The component only renders on the client side."

### Risks
Specific risks the sending agent identified that the receiver should watch for:
- "Changing this type may break the API contract in `routes.ts:42`."
- "This file is also imported by the admin bundle — verify tree-shaking."
- "The rate limiter middleware is not yet applied to this route."

### Tests run
What tests were executed and their results. Format:
- `npm test — 42 passed, 0 failed, 3 skipped`
- `npx tsc --noEmit — pass`
- `npx eslint src/ — 5 warnings, 0 errors`

### Blockers
Anything that prevented the sending agent from completing its work. Be specific:
- "Cannot merge until the API key is rotated."
- "Waiting for the design team to confirm the mobile breakpoint."
- "Type error in third-party dependency — see `@types/foo` issue #42."

### Recommendation for next agent
Actionable instructions for the receiving agent:
- "Run `release-tester` after applying these changes."
- "Ask `security-auditor` to review the new auth middleware."
- "Do not merge — wait for CI to pass."

## Handoff sequence

Standard quality gate sequence before production:

```
lead-dev (synthesis)
  → security-auditor (review)
  → lead-dev (apply security fixes if any)
  → release-tester (validate)
  → lead-dev (fix test failures if any)
  → git-specialist (verify readiness)
  → lead-dev (final summary to user)
```

## Conflict resolution

When two agents give conflicting recommendations:

1. Identify the exact point of conflict (file + line + before/after).
2. Assess which agent has stronger domain authority for that facet.
3. If domain authority is equal, prefer the more conservative option (least destructive change).
4. Explain the decision in the handoff so the next agent understands the trade-off.
