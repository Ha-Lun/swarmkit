## Claude Code

- Large or risky work: call `EnterPlanMode` first; `ExitPlanMode` is the
  approval request.
- After an approved plan, hand implementation to agy or OpenCode
  (`delegate-implementation`); do small, context-heavy or security
  edits yourself.
- **Spend Claude on the main session.** Your Opus turns go to planning, review,
  security and context-heavy edits. Work a worker can do goes to a worker
  (`agy-task` / `opencode-task`), not a Claude subagent; keep up to 3 running
  in parallel:
  - implementation from an approved plan, including domain work: a
    specialist's "use proactively" means `opencode-task --agent <name>`, not
    the Claude subagent;
  - tests: `opencode-task`, which runs them itself, instead of `test-writer`;
  - batches of mechanical edits: `agy-task` instead of `junior-dev`;
  - a second-opinion review of a large diff: `agy-task --review` instead of
    `code-proofreader`;
  - a codebase survey that can wait a few minutes: a `--review` worker that
    returns a brief;
  - delegated agents a skill asks for (e.g. `security-audit`'s research and
    general agents): `--review` workers, with the main session as the only
    writer of the skill's files.

  For quick structural questions, and while planning, use the graph tools
  yourself instead of Explore, Plan or `explore` subagents. Use a Claude
  subagent only when the task needs Claude (`security-auditor`), when you need
  the answer before a worker could return, or when workers fail or are at the
  limit.
- Delegate with the Agent tool, the specialist's name as subagent type. Packs
  (`install.sh --pack`) add domain specialists.
- Structural questions (who calls X, the shape of a big file, what a change
  touches): prefer the `codebase-memory-mcp` graph tools (`get_file_outline`,
  `trace_path`, `search_graph`, `get_architecture`) over reading whole files. If
  the repo isn't in `list_projects`, index it first: `index_repository` with only
  `repo_path` set to the git root, git repos only, never `persistence`.
