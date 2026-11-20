---
name: delegate-implementation
description: Use after a plan is approved, before writing the code yourself. Splits the plan into self-contained tasks and hands them to cheaper headless workers (agy, OpenCode), then reviews, tests and merges their branches. You plan and review; they implement.
---

# Delegating the implementation of a plan

You (Opus) plan and review; headless workers write the code on their own quota. Every hand-off costs you a prompt and a review, so it pays off on real implementation work, not on small edits.

## Keep for yourself

- Edits under ~20 lines: doing them is cheaper than specifying them.
- Anything that depends on this conversation's context, or a design you haven't pinned down yet.
- Auth, secrets, permissions and data handling. Those also get `security-auditor`.
- Client repos, unless the user has said code may go to Google or other model providers.

Everything else in the plan goes to a worker.

## 1. Split

- One task per group of files. Two tasks must never touch the same file, or their branches conflict.
- Order by dependency. Tasks that need another task's code wait until it is merged (`--base` its branch, or merge first).
- At most 3 run at once, across all backends; the wrappers refuse a fourth.

## 2. Pick the worker

| Task | Worker |
|---|---|
| Well-specified implementation, tests to write (default; you run the verify) | `agy-task --model hydrogen`, `--agent <specialist>` when a specialty applies, see `agy-delegate` |
| Trivial bulk or mechanical edits | `agy-task --model hydrogen --effort low` |
| Hard implementation (tricky logic, multi-file refactor), or the fresh-start retry after Hydrogen high failed its one resume | `agy-task --model hydrogen --effort xhigh` |
| Implementation where the worker must iterate on a test run itself (failing test, TDD, debugging) | `opencode-task` (free `opencode-go/` model), `--agent <specialist>` when a specialty applies (lane model, never `lead-dev-hybrid`), see `opencode-delegate` |
| Second opinion on your own diff | `agy-task --review --model neon --effort high` |
| Cross-review of a worker's branch | see below |

In Claude Code, UI, styling, motion and 3D work never goes to a worker: it goes to the Claude `frontend-specialist` / `animation-specialist` subagent (Sonnet). agy first: a task goes to `opencode-task` only when the worker must run tests itself.

Claude Code runs both lanes. From OpenCode use only `agy-task` (`opencode-task` refuses under OpenCode). Antigravity runs no workers.

Client repos: before the first `opencode-task` run in a repo, if `opencode-task client-repo` prints `unknown`, ask the user whether it is a client repo and record the answer (`opencode-task client-repo yes|no`); never answer it yourself. Client repos run on `opencode-go/mimo-v2.6-flash` automatically.

Workers may only use the allowlisted models in scripts/agy-task (BACKENDS 'allowed'); pick the agy model from the tiers in `agy-delegate`, use the opencode lane default unless the owner names a model (also with `--agent` unless the agent pins an allowlisted `opencode.model`), and never add a model without the owner's OK. A worker's shell only allows the test/build runners in `RUNNERS` (`scripts/agy-task`). Give it a verify command from that list, or run the verify yourself after it lands. For a project in a subdirectory, give the worker `npm --prefix <dir> test` or `npm --prefix <dir> run typecheck` as verify, and pass `--setup 'ln -s <main checkout>/<dir>/node_modules <dir>/node_modules'` so its dependencies exist (setup artifacts are not committed).

Cross-review: `opencode-task --review` (lane default model) reviews every branch an agy worker wrote; `agy-task --review --model neon --effort high` reviews a branch an OpenCode worker wrote.

If a Hydrogen high task fails after its one resume, start it fresh on Hydrogen xhigh (`--model hydrogen --effort xhigh`). If the preferred worker fails twice on the same kind of task, use another one. If none is available, Claude's own `junior-dev` (mechanical edits) and `test-writer` (tests) subagents are the fallback.

## 3. Write the prompt

The worker starts cold. Each prompt states:

- the goal in one sentence, and why;
- the exact files to change, and the interfaces (signatures, types) to keep or create;
- the constraints: style to match, what not to touch, no new dependencies;
- the verify command (`npm test -- src/api`, `python3 -m pytest tests/test_x.py`);
- "done when": the observable result.

For agy, add "use your file read and edit tools, not the shell", and name every file it must read or change: every agy run is gated to worktree files and has no shell, and agy has offered no search or directory listing since 1.5.8, so you run its verify.

## 4. Run

Commit first: workers only see committed state. Use `--setup` only to link or install dependencies; it runs as you, unrestricted. Start each task with Bash `run_in_background`, then do the parts you kept for yourself while they run. Don't poll; the background run reports when it exits.

## 5. Review and merge

For each finished task:

1. `ok` in `result.json`, then read `git diff <base>..<cli>/<slug>`. The diff is the truth.
2. Run the verify command yourself in the worktree.
3. If something is wrong, `resume` once with concrete feedback (file, line, expected behaviour). If it fails again: a Hydrogen high task starts fresh on Hydrogen xhigh; otherwise do that part yourself.
4. `git merge <cli>/<slug>`, then `<cli>-task clean <slug>`.

After the last merge, run the full test suite, then the usual review (`code-proofreader`, `security-auditor`, `release-tester`) as the change requires. Tell the user which parts were delegated and to which worker.
