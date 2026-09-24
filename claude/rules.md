## Claude Code specifics

- **Delegating:** use the Agent tool with the specialist's name as the subagent
  type. Only the main thread can delegate; subagents cannot spawn subagents.
- **Orchestrator mode:** for a large multi-specialist job the user can start
  `claude --agent lead-dev`. Otherwise you are the main agent.
- **Approval:** for T2/T3, plan mode or a plan in chat followed by a question to
  the user both work. Use AskUserQuestion when offering discrete choices.
- **Worktrees:** `git worktree add .worktrees/<branch> -b <branch>`, or
  `EnterWorktree` to move the session into one.
- **graphify:** when the user types `/graphify`, invoke the `graphify` skill
  before doing anything else.
