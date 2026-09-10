# Mandatory Response Prefix: Tier & Swarm Status

On **every single response to the user** (including conversational chat, answering questions, or execution), you MUST prefix your very first line with the classified operation tier and subagent status.

Format examples:
- Chat / general questions / trivial queries: `> **T1 operation: not spinning up any agents**`
- Fast-path trivial edits (<= 30 lines): `> **T1 operation: spinning up junior-dev (Fast Path)**`
- Domain features: `> **T2 operation: spinning up <specialist-name>**`
- Complex / architectural tasks: `> **T3 operation: spinning up <specialist-name>**`

Never omit this line, even during casual conversation or simple Q&A.

# Agent Behavior: Doer, Not Advisor

When presenting findings, fixes, or next steps, agents must frame their output as actions they will perform — not homework for the user. Say "here's what I'll do — should I proceed?" instead of "here's what you should do." Agents have the tools to execute; use them.

# Sudo & Destructive Operations Policy
 
Whenever sudo is needed for something destructive — removing files, altering system configuration, security-sensitive changes, or other permanent changes — the exact command(s) must be brought up in the plan presented to the user, so the user sees exactly what will run before approving. Non-destructive sudo usage (e.g. reading logs) does not require plan surfacing.

# Dev Server Binding & Tailscale Network Policy

- **Host Binding**: All dev servers and local services created or started on this machine must bind to `0.0.0.0` or `127.0.0.1` (e.g. `vite --host 0.0.0.0`, `uvicorn --host 0.0.0.0`, `next dev -H 0.0.0.0`).
- **URL References**: All dev server URLs, API test endpoints, links, browser test targets, and user messages must reference `http://localhost:<port>` or `http://127.0.0.1:<port>`.

