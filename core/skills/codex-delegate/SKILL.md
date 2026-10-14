---
name: codex-delegate
description: Use when handing a self-contained task to a headless Codex instance from Claude Code, for an independent review by an OpenAI model, or for well-specified work (tests included) on ChatGPT quota, run in parallel on isolated git worktrees. Not for small tasks or anything needing Claude's context.
---

# Delegating to Codex

`codex-task` runs one headless `codex exec` task on its own branch and worktree. It shares its code with `agy-task`, so the commands and `result.json` are the same. You stay the administrator: you decide what to hand off, then review and merge the result yourself.

## When

- Independent review of your own diff by a different model family (`--review`).
- Well-specified implementation or test writing on ChatGPT quota instead of yours. Unlike agy, Codex can run the tests itself.
- 2-3 independent tasks at once (shared limit of the box; `CODEX_TASK_MAX`, default 3).

Skip it for small edits (do them inline), for anything that depends on conversation context, and for the same work a Claude subagent already does. Codex starts cold: the prompt must carry the goal, the files, the constraints, the commands to verify with and what "done" looks like.

## Run

```bash
codex-task start <slug> "<self-contained prompt>"   # run via Bash run_in_background, one per task
codex-task resume <slug> "<follow-up>"              # same thread, same branch
codex-task list                                     # running and finished tasks
codex-task clean <slug> [--force]                   # remove worktree and branch once merged or discarded
```

Options: `--model` (default: the Codex config's model), `--effort low|medium|high`, `--timeout 20m`, `--base REF`, `--setup "<cmd>"`, `--review`. Use `-` as the prompt to read it from stdin.

- Sandbox: `workspace-write`. Codex can run shell commands, but writes only inside the worktree and has **no network**, so nothing gets installed. Link or install dependencies with `--setup` (it runs outside the sandbox before Codex starts), e.g. `--setup "ln -s $PWD/node_modules node_modules"`. Never copy `.env` or other secrets into the worktree.
- Codex sees only committed state: commit or stash first, or pass `--base <ref>`.
- Split parallel tasks by file. Branches that touch the same files conflict when you merge.
- Don't send client repos to Codex unless the user has said that's fine: prompts and code go to OpenAI.

The background run exits when Codex does and prints one line. Read the `result.json` named in it.

## Read the result

- Trust `ok` in `result.json`, not the prose. `warnings` lists a timeout, an interruption or a failed commit; `usage` shows the tokens spent.
- A test that failed inside the sandbox is not a denial: it shows up in `response`. Rerun the tests yourself in `worktree` before you merge; a "tests pass" in the response is a claim.
- Check `response` against `git diff <base>..codex/<slug>`; the diff is the truth.
- Review notes from Codex are advisory. Verify each against the code before acting on it.

## Merge

Review the diff, run the tests in the worktree, then `git merge codex/<slug>` and `codex-task clean <slug>`. Discard with `clean --force`. Never merge unreviewed.

## `--yolo`

Switches the sandbox to `danger-full-access`: Codex can then write anywhere and reach the network. Use it only for trusted prompts when network access is essential; say so to the user first.
