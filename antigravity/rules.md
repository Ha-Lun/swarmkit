## Antigravity

- Specialists are named subagents in the `swarmkit` plugin: delegate with
  `invoke_subagent` and the specialist's name as the agent type.
- `lead-dev` runs only as `agy --agent lead-dev`; never invoke it as a subagent.
- Chat text is hidden while a tool runs, so when you ask for plan approval with
  `ask_question`, put the complete plan in the question text.
- Read-only roles (`explore`, `code-proofreader`, `release-tester`,
  `security-auditor`) aren't enforced by tool limits here: the capability line
  at the top of each agent's instructions is binding.
