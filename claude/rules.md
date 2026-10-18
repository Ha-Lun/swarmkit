## Claude Code

- Large or risky work: call `EnterPlanMode` first; `ExitPlanMode` is the
  approval request.
- After an approved plan, hand implementation to agy or OpenCode
  (`delegate-implementation`); do small, context-heavy or security
  edits yourself.
- Delegate with the Agent tool, the specialist's name as subagent type. Packs
  (`install.sh --pack`) add domain specialists.
- Structural questions (who calls X, the shape of a big file, what a change
  touches): prefer the `codebase-memory-mcp` graph tools (`get_file_outline`,
  `trace_path`, `search_graph`, `get_architecture`) over reading whole files. If
  the repo isn't in `list_projects`, index it first: `index_repository` with only
  `repo_path` set to the git root, git repos only, never `persistence`.
