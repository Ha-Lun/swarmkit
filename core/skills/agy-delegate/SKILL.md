---
name: agy-delegate
description: Use when handing a self-contained task to a headless Antigravity (agy) instance from Claude Code, for a second model's independent review, or for bulk edits on separate quota, run in parallel on isolated git worktrees. Not for small tasks or anything needing Claude's context.
---

# Delegating to agy

`agy-task` runs one headless `agy -p` task on its own branch and worktree. You stay the administrator: you decide what to hand off, then review and merge the result yourself.

## When

- Independent review of your own diff by a different model family (`--model gemini-3.1-pro-high`).
- Bulk mechanical edits or test writing, on agy's quota instead of yours (default `gemini-3.8-flash-high`).
- 2-3 independent tasks at once. Never more: the box has 8 cores and little spare RAM.

Skip it for small edits (do them inline), for anything that depends on conversation context, and for the same work a Claude subagent already does. agy starts cold: the prompt must carry the goal, the files, the constraints and what "done" looks like.

## Run

```bash
agy-task start <slug> "<self-contained prompt>"     # run via Bash run_in_background, one per task
agy-task resume <slug> "<follow-up>"                # same conversation, same branch
agy-task clean <slug> [--force]                     # remove worktree and branch once merged or discarded
```

Options: `--model`, `--effort low|medium|high|xhigh|max`, `--timeout 20m`, `--base REF`. Use `-` as the prompt to read it from stdin.

The background run exits when agy does and prints one line. Read `result.json` named in it.

## Read the result

- agy reports `SUCCESS` even when it was blocked. Trust only `ok` in `result.json`; `denied_actions` lists what was refused.
- Edit-only by default: agy can read and edit but **cannot run shell commands** (no tests, builds or installs). Run those yourself in `worktree` before you merge.
- Check `response` against `git diff <base>..agy/<slug>`; the diff is the truth, the prose is a claim.
- Review notes from agy are advisory. Verify each against the code before acting on it.

## Merge

Review the diff, run the tests in the worktree, then `git merge agy/<slug>` and `agy-task clean <slug>`. Discard with `clean --force`. Never merge unreviewed.

## `--yolo`

Auto-approves every tool so agy can run commands. It is **not sandboxed**: `--sandbox` did not stop writes outside the worktree or network access in testing, and a worktree isolates git, not the filesystem. Use it only for trusted prompts and only when shell access is essential; say so to the user first.
