## Antigravity specifics

- **Specialists are named subagents** in the `swarmkit` plugin. Delegate with
  `invoke_subagent`, the specialist's name as the agent type, and the handoff
  template as the message.
- **Standing authorization:** the user authorizes you to spawn any specialist in
  the Specialists table without asking first, except `lead-dev`. Project-marker
  routing is mandatory. Once a T2/T3 plan is approved, delegate the domain work
  instead of doing it inline.
- **Orchestrator mode:** for a large multi-specialist job the user can start
  `agy --agent lead-dev`. Never invoke `lead-dev` as a subagent.
- **Approval:** chat text is hidden while a tool runs, so when you ask for plan
  approval with `ask_question`, embed the complete plan in the question text.
  Offer: "(Recommended) Approve and proceed", "Modify plan", "Cancel".
- **Read-only roles** (`explore`, `code-proofreader`, `release-tester`,
  `security-auditor`) can't be enforced by tool restrictions here: the
  capability line at the top of each agent's instructions is binding. Grant a
  subagent only the permissions its capabilities allow.
