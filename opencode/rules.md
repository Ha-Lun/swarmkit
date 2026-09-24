## OpenCode specifics

- **Delegating:** use the `task` tool with the specialist's agent name. Ask the
  user with the `question` tool.
- **Orchestrator mode:** `lead-dev` is a primary agent; switch to it for large
  multi-specialist jobs.
- **Ponytail plugin:** the ponytail plugin is always on and injects the
  minimum-code rules into every chat, so specialists don't need to load it.
  Intensity is stored in `~/.config/opencode/.ponytail-active`; the user
  switches it with `/ponytail lite|full|ultra|off`.
