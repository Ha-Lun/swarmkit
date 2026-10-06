# SwarmKit benchmark

Proves the SwarmKit config works in Claude Code, Antigravity (`agy`) and OpenCode, in two tiers:

- **Static** (default): free, offline and deterministic. It checks the compiled config itself.
- **Live** (opt-in): sends real prompts to a CLI and scores which specialist it actually dispatches. This tier spends your model quota.

Needs Python 3 and PyYAML (the same as `scripts/build.py`).

## Quick start

```bash
python3 bench/run.py                                  # static tier, about 10 s, exit 0 = all pass
python3 bench/run.py --installed                      # + are ~/.claude, ~/.config/opencode, ~/.gemini linked to this checkout? (WARN only)
python3 bench/run.py --live claude --yes --max-cases 2  # smoke test: one positive and one negative case
python3 bench/run.py --live agy --yes                 # all agy cases
python3 bench/run.py --live opencode --yes            # headless probe, then the manual checklist
# A/B: what the config adds on top of vanilla Claude Code
python3 bench/run.py --live claude --yes --config repo
python3 bench/run.py --live claude --yes --config none
# plan-mode cases only (~$3)
python3 bench/run.py --live claude --yes --config repo --only plan-
```

Every run ends with a scoreboard and exits non-zero on any failure. `--json PATH` writes machine-readable results. Live runs also write `bench/results/<UTC timestamp>-<cli>.json`, a Markdown report `bench/results/<timestamp>.md`, and the raw CLI event stream for each run under `bench/results/raw/`. `results/` is gitignored.

## Static tier

| Check | What it proves |
|---|---|
| S1 build idempotent | `build.py` runs twice in a temp copy of the sources with identical output, and that output equals the committed `claude/`, `opencode/` and `antigravity/` files. Sources and outputs are in sync. |
| S2 roster parity | The same agent names exist in `core/agents` and all three CLI outputs (Claude: `claude/agents` plus `claude/packs/*/agents`). Every frontmatter is valid YAML with a description. Claude models are haiku, sonnet or opus. |
| S3 delegation signals | Every Claude pack specialist description says "proactively" or "Use when" (lead-dev and the one-line core agents are exempt). The lead-dev descriptions for Claude and agy forbid subagent use. All three rules files say never to wait for approval when non-interactive. The Claude rules send large or risky work to `EnterPlanMode` first and stay under 2200 bytes. |
| S4 foreign-tool leakage | Claude bodies contain no agy tool names. OpenCode bodies contain no agy or Claude tool names. Claude `tools:` lists contain only real Claude tools or `mcp__<server>__*`, where `<server>` is in `core/mcp.json`. |
| S5 hooks and guard | The five guarded agents have their `guard.py` PreToolUse hook. Then `claude/hooks/guard.py` is run directly on 32 stdin cases: allowed commands, chaining, substitution and redirection bypasses, and test-writer and git-specialist file rules. |
| S6 rules sanity | The agy rules file is under 24,000 bytes. Every skill that a rules file or agent body tells the model to load exists in `core/skills`. The match is conservative: `Load **\`x\`**`, `` `x` skill``, `Skills to load: \`x\``. Third-party skills are listed in `cases.json` under `static.external_skills`. |
| S7 native validators | `agy plugin validate` processes every agent (SKIP if `agy` is missing). `opencode.jsonc` parses, `default_agent` exists, and its plugin and instruction paths resolve. The Claude tree has CLAUDE.md, agents, and a compiling `guard.py`, and ships no settings. |
| S8 installed links | Only with `--installed`. Every install symlink resolves into this checkout. Failures are a WARN with the exact `./install.sh --x` to run. |

Use `--repo PATH` to check another checkout. This is also how to try a deliberate defect without touching your repo: copy `core scripts claude opencode antigravity` to a temp dir, break something, then run `--repo` against the copy.

## Live tier

Each case in `cases.json` runs in a fresh throwaway git repo created in the system temp dir. The repo holds a tiny Node project plus that case's marker files (`lovable.json` with `src/integrations/supabase/`, `wrangler.toml`, Capacitor `android/`, a Dockerfile, n8n workflow JSON, a fake hardcoded key with SQL concatenation, and so on). The repo is deleted afterwards. Every delegation prompt asks for read-only review or inspection, so no plan-approval gate blocks the run. The three `plan-*` cases (Claude only, fixture `plan`: `fetchJson` in `src/api.js` with two callers and a test, plus a README typo) are the exception: `plan-t2` asks for a multi-file feature and expects `EnterPlanMode` as the first tool call; `plan-t1` (one-word typo) and `plan-t0` (a conceptual question) expect no `EnterPlanMode`. Edits stay disallowed, so nothing is changed either way.

Scoring uses only the CLI's machine output, never the model's prose:

- **dispatched**: the subagent names the CLI actually invoked.
  - Claude: `tool_use` blocks named `Agent` or `Task` in top-level assistant events, using `input.subagent_type`.
  - agy: `step_update` events with `tool_name: invoke_subagent`, using `Subagents[].TypeName` or `subagent_info.subagents[].type_name`.
- **correct**: every expectation the case sets holds. `expect.agent`: that agent is in `dispatched`, or nothing was dispatched when it is `null`; `wrong_agent` flags any other dispatch. `expect.first_tool` (Claude): the first top-level `tool_use` has that name. `expect.no_tool` (Claude): no top-level `tool_use` has that name.
- **planner_model** (Claude): the `message.model` of top-level assistant messages after the `EnterPlanMode` call, and whether it contains `opus`. It is `null` when no assistant message follows the call (for example if headless mode does not continue in plan mode). Whether headless `-p` runs switch `opusplan` to Opus in plan mode has not been verified yet; this field is how to find out.
- **status_line_ok**: the reply's first line matches `expect.status_line` (default `^> \*\*T\d operation: `).
- Headlines: delegation accuracy (`category: positive`), false-delegation rate (`category: negative`), plan-mode gate (`category: plan`) with the share of planner models that were Opus, status-line compliance, mean duration, and cost or tokens.

Options: `--only PREFIXES` (comma-separated case-id prefixes, e.g. `--only plan-`), `--max-cases N` (the first N applicable cases after `--only`; the first two are the cheapest positive and negative), `--repeat N`, `--timeout S` (per CLI call, default 240; the whole process group is killed on timeout), `--model M`, `--json PATH`.

### Claude Code

Runs `claude -p ... --output-format stream-json --verbose --no-session-persistence --max-budget-usd <--budget> --permission-mode acceptEdits --disallowedTools "Edit Write NotebookEdit"` with the fixture as cwd.

- **Cost.** With the installed config, the first turn alone costs about $1 (measured: $1.04 and $1.10 for the two smoke cases), because it loads the rules, 33 agent descriptions, skills and your MCP tools. Every Claude live run prints an estimate first (about $1 per case). `--max-budget-usd` is checked only *after* a turn, so `--budget` (default 0.75) is a soft cap that the first turn can overshoot. `--max-total-usd` (default 3) stops the run before the next case once the total spend reaches it, so it too can be overshot by up to one case. A full 15-case run costs roughly $15 and needs `--max-total-usd 20`. To make it cheaper: `--model sonnet` (or `--model haiku` for a smoke test of the plumbing only); do not use `--model` for the plan cases, since they test the `opusplan` switch. `--only plan-` runs just the three plan cases (about $3).
- **`--config installed`** (default): your real `~/.claude`, i.e. whichever checkout `install.sh` linked. The report records that checkout's commit (`config_commit`), which may differ from `repo_commit`.
- **`--config repo` / `none`**: a temp `CLAUDE_CONFIG_DIR` holding a symlink to `~/.claude/.credentials.json` (for auth) and a copy of `settings.json` (never printed). `repo` also links `CLAUDE.md`, `agents/` and `hooks/guard.py` from this repo and `skills/` from `core/skills`. `none` is vanilla Claude Code. Both modes drop any plan-gate entry left in the copy by older installs. Together they make an A/B comparison: config vs vanilla. `repo` mode links only the core agents, so live routing cases that expect a pack specialist need that pack installed. If a mode can't authenticate headless, its runs are marked SKIPPED with the reason.
- **Guard hooks resolve through `$HOME`, not `CLAUDE_CONFIG_DIR`.** The agents' hook command is `python3 ~/.claude/hooks/guard.py <agent>`, which the shell expands with `$HOME`. So in `repo` mode the *installed* guard still runs, and the `hooks/guard.py` link in the temp dir is not what executes. The live tier scores dispatch, not the guard, and S5 tests this repo's guard directly.

### Antigravity (agy)

Runs `agy -p ... --output-format stream-json`. A copy of `antigravity/plugins/swarmkit` goes into the fixture at `.agents/plugins/swarmkit`, which is the verified way to load the plugin from a workspace. If the plugin is also installed globally in `~/.gemini/config/plugins`, both copies load; they have the same names, so this is harmless. Only the repo plugin is supported: `--config none` is SKIPPED.

Headless agy may deny file reads in untrusted directories. Denials are recorded as a note and dispatch is still scored. `--agy-skip-permissions` passes `--dangerously-skip-permissions`; it is off by default and only reasonable because each fixture is a disposable temp dir. Cost is reported as tokens.

### OpenCode

OpenCode's free tier rejects non-interactive runs ("can only be used from within OpenCode"), and the benchmark does not try to bypass that. `--live opencode` first runs `opencode run` on a trivial prompt:

- If the probe fails, the benchmark writes `bench/results/opencode-manual-checklist.md` (cases, expected specialists, copy-paste prompts, and how to spot a `task` tool call in the TUI). It also writes the fixtures to `bench/results/opencode-fixtures/<case>/` so you can `cd` into one and run `opencode`.
- If the probe succeeds (for example, on a paid provider), the cases run through `opencode run --format json` and are scored from `task` tool parts. This parser has never seen real output yet, so treat it as unverified.

## Adding a case

Append to `cases` in `cases.json`:

```json
{"id": "...", "title": "...", "category": "positive|negative|plan", "fixture": "<key in fixtures>",
 "prompt": "read-only review request ...", "expect": {"agent": "specialist-name or null", "status_line": "optional regex",
                                                     "first_tool": "optional, Claude", "no_tool": "optional, Claude"},
 "applies_to": ["claude", "agy", "opencode"]}
```

A fixture is a `{path: content}` overlay on `fixtures.base`. The optional keys `_branch`, `_commits` (`[{msg, files}]`) and `_uncommitted` build git history.
