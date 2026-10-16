---
name: hybrid-delegate
description: Use when Claude Code (Opus) orchestrates a plan by dispatching implementation to headless agy-task and opencode-task workers in parallel to spread usage across quotas; not for small tasks, not for work depending on conversation context, not for auth/secrets/data handling.
---

# Hybrid delegation

You are Opus, the planner and reviewer. The actual implementation is spread across headless workers on their own quotas. This skill is the scheduling/load-spreading layer **on top of** `delegate-implementation`; read that skill first for how to split a plan, write a cold-start prompt, and run the review/merge loop.

## Keep for yourself

Same as `delegate-implementation`:

- Edits under ~20 lines.
- Anything that depends on this conversation's context or an unsettled design.
- Auth, secrets, permissions and data handling (also give these to `security-auditor`).
- Client repos, unless the user has said code may go to Google or other model providers.

Everything else in the approved plan goes to a worker.

## Pipeline

1. **Plan and get approval.** Follow your orchestrator flow. Be explicit about which parts may go to which backend.
2. **Commit first.** Workers see only committed state.
3. **Split into file-disjoint tasks.** Reference `delegate-implementation` §1.
4. **Pick the backend per task:**

   | Task | Backend |
   |---|---|
   | Implementation where the worker should run its own tests | `opencode-task` (free `opencode-go/` model) |
   | Bulk edits / boilerplate where you run the tests | `agy-task` (default `gemini-3.8-flash-high`; `--model claude-sonnet-4-6` for harder logic) |
   | Second opinion on your own diff | `agy-task --review --model claude-sonnet-4-6` |
   | Context-dependent work that cannot be handed off cold | Your own `Agent` subagents (Claude lane) |

   Prompt additions that avoid wasted resumes: tell opencode workers "you are already in the worktree; do not `cd`", give them the exact verify command (`node test/x.test.js`, `npm test -- src/x`), and tell agy workers "file view/search/edit tools only, no shell".
5. **Keep slots full.** Start workers with a background Bash call. The running-task limit is **shared across all backends**; the wrapper reads it from the invoked backend's `*_TASK_MAX` (default 3). Do not treat it as 3 per backend. When a task lands and is merged or discarded, immediately start the next queued task so both quotas stay busy.
6. **Review and merge as results land.** For each finished task:
   - Trust only `ok` in `result.json`; `agy` reports `SUCCESS` even when blocked.
   - Read `git diff <base>..<cli>/<slug>`; the diff is the truth. An agy task that is `NOT ok` only because it tried a shell command (denied `RunCommand`) but produced a diff is not a failure: review the diff and run the verify command yourself instead of resuming.
   - Rerun the verify command in the worktree yourself.
   - If something is wrong, `resume` once with concrete feedback (file, line, expected behaviour). `opencode-task` kills a worker at `--max-denied` (10) denied commands or `--max-tool-errors` (20) failed tool calls and records `stopped_by` in `result.json` (`max-denied`, `max-tool-errors`, `timeout`); never resume a `max-denied` worker. If a worker is stopped or still fails after the one resume, take the task over yourself (a subagent or another lane).
   - `git merge <cli>/<slug>`, then `<cli>-task clean <slug>`.
7. **Cheap second opinion before you report.** Your own review reads diffs on Claude quota; a different model catches different mistakes on other quota. For merged logic of more than ~50 lines, run `agy-task start review-<n> --review --model claude-sonnet-4-6` on the merged diff and read only its findings. Skip it for boilerplate and renames.
8. **After the last merge:** run the full test suite, then apply the usual quality gate (`security-auditor`, `code-proofreader`, `release-tester` as the change requires). Report to the user which parts went to which worker/backend.

## Workflow mode

With the `Workflow` tool available (dynamic workflows on) and 3 or more tasks, run the saved `hybrid-build` workflow instead of the hand-run loop above. It takes `args = { tasks: [{ slug, lane: 'opencode'|'agy', prompt, verify, files }], review: true }`, runs each worker through a small Haiku dispatcher (`--wait` queues behind the shared cap), verifies every branch with its own verify command, cross-reviews it with `agy-task --review`, and returns only `{ ready, failed, findings }`. You merge the `ready` branches and handle the rest; your context never sees raw worker output. Dynamic workflows are off by default on some plans: `enableWorkflows` in settings.json, or the Dynamic workflows row in `/config`.

## Safety facts

- The wrappers are guards, not sandboxes. `agy --yolo` and `opencode --yolo` are unsandboxed.
- `opencode-task` denies file-tool access outside the worktree (`external_directory`), but its allowed shell runners can still write anywhere: a guard against stray edits, not a boundary.
- Never copy `.env` or other secrets into a worktree.
- Only send client repos to a provider the user has OK'd.
- Use `--setup` only for linking or installing dependencies.
