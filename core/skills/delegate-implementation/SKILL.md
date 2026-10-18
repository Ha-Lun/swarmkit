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
| Implementation where the worker should run the tests itself | `opencode-task` (free `opencode-go/` model), see `opencode-delegate` |
| Edits and boilerplate where you run the tests | `agy-task` (default `gemini-3.8-flash-high`), see `agy-delegate` |
| Harder logic | `opencode-task --model opencode-go/kimi-k2.7-code` |
| Second opinion on your own diff | `agy-task --review --model gemini-3.8-flash-high` |
| Cross-review of a worker's branch | the other family's worker, see below |

Workers never run Claude models; agy-task refuses them. A worker's shell only allows the test/build runners in `RUNNERS` (`scripts/agy-task`). Give it a verify command from that list, or run the verify yourself after it lands.

Cross-review uses a different model family from the writer: an opencode-written branch gets `agy-task --review --model gemini-3.8-flash-high`; an agy-written branch gets `opencode-task --review --model opencode-go/glm-5.3`.

If the preferred worker fails twice on the same kind of task, use another one. If none is available, Claude's own `junior-dev` (mechanical edits) and `test-writer` (tests) subagents are the fallback.

## 3. Write the prompt

The worker starts cold. Each prompt states:

- the goal in one sentence, and why;
- the exact files to change, and the interfaces (signatures, types) to keep or create;
- the constraints: style to match, what not to touch, no new dependencies;
- the verify command (`npm test -- src/api`, `python3 -m pytest tests/test_x.py`);
- "done when": the observable result.

For agy, add "use your file view, search and edit tools, not the shell".

## 4. Run

Commit first: workers only see committed state. Use `--setup` only to link or install dependencies; it runs as you, unrestricted. Start each task with Bash `run_in_background`, then do the parts you kept for yourself while they run. Don't poll; the background run reports when it exits.

## 5. Review and merge

For each finished task:

1. `ok` in `result.json`, then read `git diff <base>..<cli>/<slug>`. The diff is the truth.
2. Run the verify command yourself in the worktree.
3. If something is wrong, `resume` once with concrete feedback (file, line, expected behaviour). If it fails again, do that part yourself.
4. `git merge <cli>/<slug>`, then `<cli>-task clean <slug>`.

After the last merge, run the full test suite, then the usual review (`code-proofreader`, `security-auditor`, `release-tester`) as the change requires. Tell the user which parts were delegated and to which worker.
