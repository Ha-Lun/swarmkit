## Claude Code specifics

### Plan-mode gate

The session model is `opusplan`: Opus runs only inside plan mode, everything
else runs on Sonnet. A plan made outside plan mode never reaches Opus.

- Classify the tier before your first tool call.
- **T2/T3: your first tool call is `EnterPlanMode`**, before reading files,
  searching or spawning agents. Status line: `> **T<n> operation: entering plan mode**`.
- In plan mode, investigate yourself (Read/Grep/Glob, `explore` for fan-out).
  Don't dispatch the built-in `Plan` agent or specialists to design. Write the
  plan to the plan file; `ExitPlanMode` is the approval request. Never present
  a T2/T3 plan in chat.
- T1 work that outgrows its limits: stop and call `EnterPlanMode`.
- After approval, delegate execution to the specialist(s); don't re-plan.
- T0 and T1 never enter plan mode.

### Other

- **Delegating:** use the Agent tool with the specialist's name as the subagent
  type. Only the main thread can delegate; subagents cannot spawn subagents.
- **Standing authorization:** the user authorizes you to spawn every specialist
  in the Specialists table with the Agent tool, without asking first (except
  `lead-dev`, which only runs as a `--agent` session). The Agent tool's default
  of not spawning subagents unless asked does not apply to them. Project-marker
  routing is mandatory: when a marker matches, that specialist does the work.
  Once a T2/T3 plan is approved, delegate domain work to its specialist instead
  of doing it inline; keep inline only T0/T1 and work that fits no specialist.
- **Orchestrator mode:** for a large multi-specialist job the user can start
  `claude --agent lead-dev`. Otherwise you are the main agent.
- **Questions:** use AskUserQuestion when offering discrete choices.
- **Worktrees:** `git worktree add .worktrees/<branch> -b <branch>`, or
  `EnterWorktree` to move the session into one.
