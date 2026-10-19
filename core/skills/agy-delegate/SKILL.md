---
name: agy-delegate
description: Use when handing a self-contained task to a headless Antigravity (agy) instance from Claude Code, for implementation from an approved plan (see delegate-implementation), a second model's independent review, or bulk edits on separate quota, run in parallel on isolated git worktrees. Not for small tasks or anything needing Claude's context.
---

# Delegating to agy

`agy-task` runs one headless `agy -p` task on its own branch and worktree. You stay the administrator: you decide what to hand off, then review and merge the result yourself.

## When

- Independent review by a different model family: your own diff, or an opencode-written branch (`--review` on the agy lane default). An agy-written branch is reviewed by `opencode-task --review` (its lane default) instead. No --model flag.
- Bulk mechanical edits or test writing, on agy's quota instead of yours (default `gemini-3.8-flash-high`).
- 2-3 independent tasks at once. Never more: the box has 8 cores and little spare RAM.

Workers may only use the allowlisted models in scripts/agy-task (BACKENDS 'allowed'); use the lane default unless the owner names a model, and never add a model without the owner's OK. A worker's shell only allows the test/build runners in `RUNNERS` (`scripts/agy-task`); agy's only the read-only ones (no test runner). Give an opencode worker a verify command from that list; for agy, run the verify yourself after it lands.

Skip it for small edits (do them inline), for anything that depends on conversation context, and for the same work a Claude subagent already does. agy starts cold: the prompt must carry the goal, the files, the constraints and what "done" looks like. Say "use your file view, search and edit tools, not the shell" in every prompt, reviews included: a model that reaches for a shell command (often `cat -n` for line numbers) is denied and returns nothing. If that happens, `resume` it with that instruction; in testing the retry succeeded.

## Run

```bash
agy-task start <slug> "<self-contained prompt>"     # run via Bash run_in_background, one per task
agy-task resume <slug> "<follow-up>"                # same conversation, same branch
agy-task list                                       # running and finished tasks
agy-task clean <slug> [--force]                     # remove worktree and branch once merged or discarded
```

Options: `--model`, `--effort low|medium|high|xhigh|max`, `--timeout 20m`, `--base REF`. Use `-` as the prompt to read it from stdin.

- `--review` for tasks that answer in text (a review, an analysis): `ok` then means a non-empty response with no tool denied, instead of "files changed". Without it a review reports NOT ok.
- `--setup "<cmd>"` runs in the worktree before agy. A fresh worktree has tracked files only, so use it for dependencies, e.g. `--setup "ln -s $PWD/node_modules node_modules"`. Never copy `.env` or other secrets into it.
- agy sees only committed state: uncommitted changes in your checkout are invisible to it (the wrapper warns). Commit or stash first, or pass `--base <ref>`.
- At most 3 tasks run at once (`AGY_TASK_MAX`); a fourth start is refused.
- Split parallel tasks by file. Branches that touch the same files conflict when you merge.
- Don't send client repos to agy unless the user has said that's fine: prompts and code go to Google.

The background run exits when agy does and prints one line. Read `result.json` named in it.

## Read the result

- agy reports `SUCCESS` even when it was blocked. Trust only `ok` in `result.json`; `denied_actions` lists what was refused, `warnings` lists a timeout (partial output), an interruption or a failed commit. `usage` shows the tokens spent. Slugs are lowercase letters, digits, `.`, `_`, `-`.
- Gated by default, plain runs and `--agent` alike: a PreToolUse hook in the worktree (`scripts/agy-gate.py`, never committed) allows the file tools on worktree paths only, never `.git`, `.agents` or `.gemini`, and never edits the root `AGENTS.md` or `GEMINI.md` (agy loads them as rules), and denies MCP, the browser and the web. A plain run may also run read-only commands (`git status/diff/log/show`, `ls`, `cat` of source paths; no shell syntax), never a test runner (it would run worker-written code past the gate); `--agent <specialist>` (start only; resume reuses it) gets no shell. Run tests, builds and installs yourself in `worktree` before you merge. Gate denials show up in `denied_actions`. A run marked `gate hook inactive` or `gate check unavailable` was not (provably) gated and is not committed: treat its worktree, and anything agy could reach, as untrusted. A base that tracks `.agents/` (or `.agent`, `_agents`, `_agent`, `.gemini`) is refused, and so is a launch while the worktree has such an entry besides the wrapper's overlay (e.g. made by `--setup`). An agy version other than the probed one exits 2; re-probe as `agy-task --help` describes before setting `AGY_TASK_ALLOW_UNPROBED=1`.
- Check `response` against `git diff <base>..agy/<slug>`; the diff is the truth, the prose is a claim.
- Review notes from agy are advisory. Verify each against the code before acting on it.

## Merge

Review the diff, run the tests in the worktree, then `git merge agy/<slug>` and `agy-task clean <slug>`. Discard with `clean --force`. Never merge unreviewed.

## `--yolo`

Auto-approves every tool so agy can run commands. It is **not sandboxed**: `--sandbox` did not stop writes outside the worktree or network access in testing, and a worktree isolates git, not the filesystem. Use it only for trusted prompts and only when shell access is essential; say so to the user first.
