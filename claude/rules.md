## Claude Code

- Large or risky work: call `EnterPlanMode` first; `ExitPlanMode` is the
  approval request. Before `ExitPlanMode` on a plan touching ~3+ files, or
  auth, data, CI or infra, have a Hydrogen worker critique it: pipe a short
  ask ("critique this plan: gaps, risks, wrong assumptions; file read tools
  only, no shell; read <files>") plus the plan into
  `agy-task start plan-<slug> --review --model hydrogen --effort xhigh -`.
  Weigh its findings, ask for approval, then `agy-task clean plan-<slug> --force`.
  Skip it for client repos the user hasn't cleared for Google.
- After an approved plan, hand implementation to agy or OpenCode
  (`delegate-implementation`); do small, context-heavy or security
  edits yourself.
- **Spend Claude on the main session.** Your Opus turns go to planning, review,
  security and context-heavy edits. Work a worker can do goes to a worker, not
  a Claude subagent; keep up to 3 running in parallel. **agy first**:
  `agy-task` (Gemini 4) is the default lane, `opencode-task` only when the
  worker must run tests itself (TDD, debugging a failing run). agy has no
  shell, so you run the verify after an agy task lands.
  - Argon (`--model argon`, high by default): implementation from an
    approved plan, including domain work (a specialist's "use proactively"
    means `agy-task --agent <name>`, not the Claude subagent); writing tests;
    a codebase survey that can wait a few minutes (`--review`, returns a
    brief). `--effort medium|low` for trivial bulk or mechanical edits
    instead of `junior-dev`.
  - Hydrogen (`--model hydrogen`, high by default): a second-opinion review
    of a large diff instead of `code-proofreader`; cross-review of a worker's
    branch; hard implementation (tricky logic, a multi-file refactor); and the
    retry when an Argon task fails after its one resume (a fresh start on
    Hydrogen). `--effort xhigh` (slow) for diffs over ~300 lines or with
    concurrency or algorithmic risk, and for the plan critic above.
  - A branch Hydrogen wrote is cross-reviewed by `opencode-task --review`.
  - Delegated agents a skill asks for (e.g. `security-audit`'s research and
    general agents): `--review` workers, with the main session as the only
    writer of the skill's files.
  - UI, styling, motion and 3D stay on the Claude `frontend-specialist` /
    `animation-specialist` subagent: it can look at the page.

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
