# Claude Code benchmark

Stock Claude Code vs the SwarmKit config, headless (`claude -p`), on five tasks against this repository at one pinned commit (`run.py: PINNED`). Pass/fail comes from a script per task (`tasks/*/accept.sh`); there is no judge model.

- `run.py --work DIR --selftest`: each accept script must fail on the starting state and pass on `solution.sh`.
- `run.py --work DIR --canary`: prints what each arm actually loads (agents, skills, SwarmKit rules).
- `run.py --work DIR [--reps N]`: the runs. Appends to `results/runs.jsonl`, raw streams in `results/raw/`, diffs in `results/diffs/`. Resumable.
- `summarize.py`: `results/runs.jsonl` -> `site/public/data/benchmark_metrics.json`.

Arms (same model, same prompt, fresh worktree per run, no MCP servers, `--permission-mode acceptEdits`):
- **A stock**: `--setting-sources project,local --disable-slash-commands`. The canary shows 5 built-in agents, 0 skills, no SwarmKit rules.
- **B SwarmKit**: the installed user config. This is the whole installed environment, not only SwarmKit (the canary shows 41 agents and 113 skills, including other plugins), so its extra context is part of what is measured.

Limits, stated on the site too: the project `.claude/CLAUDE.md` is loaded by both arms; headless runs cannot answer the swarm's plan-approval step; the task files live in this repo, so an agent that searches the filesystem could find them (not observed); few runs per cell means medians are weak.
