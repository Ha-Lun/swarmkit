## Claude Code specifics

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
- **Approval:** for T2/T3, enter plan mode (`EnterPlanMode`) and write the plan
  there; `ExitPlanMode` is the approval request. The session model is
  `opusplan`, so planning runs on Opus and execution on Sonnet — a plan written
  in chat outside plan mode skips Opus. T0/T1 never enter plan mode. Use
  AskUserQuestion when offering discrete choices.
- **Worktrees:** `git worktree add .worktrees/<branch> -b <branch>`, or
  `EnterWorktree` to move the session into one.
