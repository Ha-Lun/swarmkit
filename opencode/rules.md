## OpenCode specifics

- **Delegating:** use the `task` tool with the specialist's agent name. Ask the
  user, including for plan approval, with the `question` tool.
- **Orchestrator mode:** `lead-dev` is the default primary agent
  (`default_agent` in `opencode.jsonc`); it plans and dispatches, specialists
  do the file and shell work.
- **Ponytail:** ships as the `ponytail` skills plus the
  `/ponytail lite|full|ultra|off` command. The shared rules above already carry
  the ponytail principle, so specialists don't need to load it.
