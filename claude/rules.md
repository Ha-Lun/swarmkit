## Claude Code

- Large or risky work: call `EnterPlanMode` first; `ExitPlanMode` is the
  approval request. Before `ExitPlanMode` on a plan touching ~3+ files, or
  auth, data, CI or infra, have a Neon worker critique it: pipe a short
  ask ("critique this plan: gaps, risks, wrong assumptions; file read tools
  only, no shell; read <files>") plus the plan into
  `agy-task start plan-<slug> --review --model neon --effort high -`. If that run fails,
  rerun it with `--model hydrogen --effort xhigh`.
  Weigh its findings, ask for approval, then `agy-task clean plan-<slug> --force`.
  Skip it for client repos the user hasn't cleared for Google.
- After an approved plan, hand implementation to agy or OpenCode
  (`delegate-implementation`). Outside a plan too, anything you can write as
  a self-contained spec goes to a worker, medium work included. Do it
  yourself only for a few-line edit that needs no new reads, a change whose
  context costs more to write down than to make, or a security fix.
- **Spend Claude on the main session.** Your Opus turns go to planning, review,
  security and context-heavy edits. Work a worker can do goes to a worker, not
  a Claude subagent; keep up to 3 running in parallel. **agy first**:
  `agy-task` (Gemini 4) is the default lane, `opencode-task` only when the
  worker must run tests itself (TDD, debugging a failing run). agy has no
  shell, so you run the verify after an agy task lands (cap its output,
  e.g. `| tail -n 40`).
  - Hydrogen (`--model hydrogen`, high by default): implementation from an
    approved plan, including domain work (a specialist's "use proactively"
    means `agy-task --agent <name>`, not the Claude subagent); writing tests;
    any investigation needing more than ~3 file reads (`--review`, returns
    a brief). `--effort medium|low` for trivial bulk or mechanical edits
    instead of `junior-dev`; `--effort xhigh` for hard implementation (tricky
    logic, a multi-file refactor), the fresh-start retry when a Hydrogen
    high task fails after its one resume, and the fallback when a Neon run fails.
  - Neon high (`--model neon --effort high`): every review role: the plan
    critic above, a second-opinion review of your own diff instead of
    `code-proofreader`, and cross-review of an OpenCode worker's branch. If a
    Neon run fails, rerun it on Hydrogen xhigh. It shares the Gemini quota
    with Hydrogen at about twice the cost per token. Neon high caught a
    security bug Hydrogen missed; Neon xhigh found nothing more at 3x the
    quota. Argon is retired (bench/FINDINGS.md).
  - Cross-review: `opencode-task --review` reviews every branch an agy worker
    wrote; `agy-task --review --model neon --effort high`
    reviews a branch an OpenCode worker wrote.
  - Client repos: before the first `opencode-task` run in a repo, if
    `opencode-task client-repo` prints `unknown`, ask the user (once per repo)
    whether it is a client repo and record it with `opencode-task client-repo
    yes|no`; never answer it yourself. Client repos run on mimo-v2.6-flash.
  - Delegated agents a skill asks for (e.g. `security-audit`'s research and
    general agents): `--review` workers, with the main session as the only
    writer of the skill's files.
  - Visual UI work (styling, layout, motion, 3D) stays on the Claude
    `frontend-specialist` / `animation-specialist` subagent: it can look at
    the page. UI logic (state, data flow, events) goes to agy like any code.

  For quick structural questions, and while planning, use the graph tools
  yourself instead of Explore, Plan or `explore` subagents. Use a Claude
  subagent only when the task needs Claude (`security-auditor`), when you need
  the answer before a worker could return, or when workers fail or are at the
  limit.
- **Context is the cost.** Every main-session tool call re-reads the whole
  conversation, so usage grows with context size times the number of calls,
  not with the work done. Batch shell work into one call instead of many small
  ones. Once the context passes ~80k tokens, hand investigation and debugging
  to a worker (`--review` returns a brief), and suggest a fresh session
  (`/clear`) when the topic changes.
- Delegate with the Agent tool, the specialist's name as subagent type. Packs
  (`install.sh --pack`) add domain specialists.
- Structural questions (who calls X, the shape of a big file, what a change
  touches): prefer the `codebase-memory-mcp` graph tools (`get_file_outline`,
  `trace_path`, `search_graph`, `get_architecture`) over reading whole files. If
  the repo isn't in `list_projects`, index it first: `index_repository` with only
  `repo_path` set to the git root, git repos only, never `persistence`.
