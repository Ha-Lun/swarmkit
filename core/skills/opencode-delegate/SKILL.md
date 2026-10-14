---
name: opencode-delegate
description: Use when handing a self-contained implementation task to a headless OpenCode instance on a free model from Claude Code, especially when the worker should run the tests itself, run in parallel on isolated git worktrees. Not for small tasks or anything needing Claude's context.
---

# Delegating to OpenCode

`opencode-task` runs one headless `opencode run` task on its own branch and worktree. It shares its code with `agy-task`, so the commands and `result.json` are the same. You stay the administrator: you decide what to hand off, then review and merge the result yourself. For when to delegate and how to split a plan, follow `delegate-implementation`.

## Run

```bash
opencode-task start <slug> "<self-contained prompt>"   # run via Bash run_in_background, one per task
opencode-task resume <slug> "<follow-up>"              # same session, same branch
opencode-task list                                     # running and finished tasks
opencode-task clean <slug> [--force]                   # remove worktree and branch once merged or discarded
```

Options: `--model opencode-go/<model>` (default: the free model set in `scripts/agy-task`; use `opencode-go/` models, the user's subscription), `--effort <variant>`, `--timeout 20m`, `--base REF`, `--setup "<cmd>"`, `--review`. Use `-` as the prompt to read it from stdin.

- Each run gets a config overlay for that process only. It allows edits, limits the shell to common test, lint and build commands (`npm test`, `npm run test|lint|build|typecheck`, `pytest`, `python3 -m unittest`, `go test`, `cargo test`, `make test`, …) plus `git status|diff|log|show`, and turns off web fetches and subagents. Name the exact test command in the prompt; other commands are denied and listed in `denied_actions`. With `--review`, edits are denied too.
- **This is a guard against accidents, not a sandbox.** A test runner runs code the worker can write itself (a test, a `conftest.py`, a Makefile target), with your user rights, your environment variables and network access. Only delegate repos and prompts you'd let a junior developer run unattended.
- Install commands are denied inside the run: link dependencies with `--setup`, e.g. `--setup "ln -s $PWD/node_modules node_modules"`. `--setup` runs as you, unrestricted, so keep it to linking or installing. Never copy `.env` or other secrets into the worktree.
- OpenCode sees only committed state: commit or stash first, or pass `--base <ref>`.
- Test runs leave build artifacts; if the repo doesn't ignore them (`__pycache__/`, coverage files), they end up in the commit. Drop them before merging.
- Free models are weaker than you: give exact interfaces, file paths and the verify command, and expect to `resume` with concrete feedback now and then.
- Don't send client repos unless the user has said that's fine: code goes to the model provider.

## Read the result

- Trust `ok` in `result.json`, not the prose. `denied_actions` lists blocked commands. `warnings` lists a timeout, an interruption, a failed commit, or files that changed in the main checkout during the run. That last one is advisory: if they aren't your own edits or merges, the worker wrote outside its worktree, so inspect the main checkout first.
- Check `response` against `git diff <base>..opencode/<slug>`; the diff is the truth, and "tests pass" is a claim until you rerun them in `worktree`.

## Merge

Review the diff, run the tests in the worktree, then `git merge opencode/<slug>` and `opencode-task clean <slug>`. Discard with `clean --force`. Never merge unreviewed.

## Running alongside your own OpenCode

Delegated runs don't change the user's OpenCode config: the overlay lives in the environment of that one process. They do share the account's quota and rate limits, the login, and the session history (titled `delegate: <slug>`). The user can keep working in OpenCode interactively at the same time.

## `--yolo`

Lifts the shell limit. OpenCode has no sandbox, so the model can then run anything as the user. Use it only for trusted prompts; say so to the user first.
