## OpenCode

- Delegate with the `task` tool and the specialist's agent name. Ask the user,
  including for plan approval, with the `question` tool.
- `lead-dev-hybrid` is the default primary agent (`default_agent` in
  `opencode.jsonc`); it plans and dispatches to agy workers or specialist subagents, which do
  the file work.
- Start workers only with `agy-task`; `opencode-task` is Claude Code's lane and
  refuses under OpenCode.
- Ponytail ships as the `ponytail` skills and `/ponytail lite|full|ultra|off`.
- When spawning subagents via the `task` tool, always announce the selected model
  in your response so the user can see which model is being used.
