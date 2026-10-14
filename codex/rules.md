## Codex

- Specialists are custom agents in `~/.codex/agents/`: delegate by naming the
  specialist in your request (e.g. "have security-auditor review this diff").
  Subagents can't spawn their own, so keep delegation one level deep.
- `lead-dev` is an orchestrator; you already are one, so don't spawn it.
- Read-only roles (`explore`, `code-proofreader`, `release-tester`,
  `security-auditor`) are only partly enforced here (shell is off where the role
  has none, edits aren't): the capability line at the top of each agent's
  instructions is binding.
- Ask for plan approval in plain text with the complete plan, then wait.
