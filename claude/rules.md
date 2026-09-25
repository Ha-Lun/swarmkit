## Claude Code specifics

- **Delegating:** use the Agent tool with the specialist's name as the subagent
  type. Only the main thread can delegate; subagents cannot spawn subagents.
- **Orchestrator mode:** for a large multi-specialist job the user can start
  `claude --agent lead-dev`. Otherwise you are the main agent.
- **Approval:** for T2/T3, enter plan mode (`EnterPlanMode`) and write the plan
  there; `ExitPlanMode` is the approval request. The session model is
  `opusplan`, so planning runs on Opus and execution on Sonnet — a plan written
  in chat outside plan mode skips Opus. T0/T1 never enter plan mode. Use
  AskUserQuestion when offering discrete choices.
- **Worktrees:** `git worktree add .worktrees/<branch> -b <branch>`, or
  `EnterWorktree` to move the session into one.
- **graphify:** when the user types `/graphify`, invoke the `graphify` skill
  before doing anything else.
