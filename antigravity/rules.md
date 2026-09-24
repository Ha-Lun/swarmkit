## Antigravity specifics

- **Specialists are skills.** Antigravity has no named custom subagents. Each
  specialist ships as a skill in the `swarmkit` plugin with the same name.
  Load the skill and follow it yourself, or spawn a subagent with
  `define_subagent` + `invoke_subagent`, passing the skill's full text as the
  system prompt (never just its one-line description).
- **Approval:** chat text is hidden while a tool runs, so when you ask for plan
  approval with `ask_question`, embed the complete plan in the question text.
  Offer: "(Recommended) Approve and proceed", "Modify plan", "Cancel".
- **Read-only roles** (`explore`, `code-proofreader`, `release-tester`) can't be
  enforced by tool restrictions here: follow the capability line at the top of
  each specialist skill.
