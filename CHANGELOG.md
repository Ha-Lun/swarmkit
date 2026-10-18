# Changelog

All notable changes to the opencode-config repository.

## [Unreleased]

### Removed
- 2026-10-16: the `lead-dev` agent and the whole Codex target (the `codex-task` worker lane and `codex-delegate` skill, the `codex/` build outputs and `codex/rules.md`, `./install.sh --codex`). Why: `lead-dev-hybrid` is now the single orchestrator (OpenCode's default primary agent too) and also covers the no-worker case by dispatching specialist subagents; there is no Codex subscription. To get them back: the last commit before the removal is tagged `archive/lead-dev-and-codex-task` (a local tag; the same commit, `f3afa6c`, is in main's history).
  - Read a file: `git show archive/lead-dev-and-codex-task:core/agents/lead-dev.md`; list what was there: `git ls-tree -r --name-only archive/lead-dev-and-codex-task -- codex core/skills/codex-delegate`
  - Restore: `git checkout archive/lead-dev-and-codex-task -- core/agents/lead-dev.md core/agents/claude/lead-dev.md core/agents/opencode/lead-dev.md core/skills/codex-delegate scripts/codex-task codex`, then `python3 scripts/build.py`.
  - `scripts/build.py`, `install.sh`, `scripts/agy-task` (Codex backend), `bench/run.py` and `bench/compare.py` have had other changes since, so don't check them out whole from the tag: diff them (`git diff archive/lead-dev-and-codex-task HEAD -- scripts/build.py install.sh scripts/agy-task`) and merge the Codex/lead-dev parts back by hand. `opencode/opencode.jsonc` `default_agent` and the README rows need the same.

### Added
- feat: `install.sh --alias` (or one terminal prompt) adds `claude` / `agy` aliases that start `lead-dev-hybrid` to `~/.bashrc` (and `~/.zshrc`) on hybrid installs; `--slim` and `--uninstall` remove them
- feat: `opencode-task` (headless `opencode run` on free models, shell limited by a per-run config overlay) and the `delegate-implementation` skill: after an approved plan, Claude hands implementation to agy/OpenCode and reviews, tests and merges the branches; one running-task limit across all workers; files changed in the main checkout during a run are reported
- feat: Codex as an opt-in fourth build target (`codex/agents/*.toml`, `codex/AGENTS.md`, `./install.sh --codex`, not in `--all`) and `codex-task` + `codex-delegate` skill for headless delegation from Claude Code; `agy-task` now picks its backend from the program name
- animation-specialist agent for 2D/3D web animation (Motion, GSAP, Anime.js, React Spring; Three.js, R3F, Drei) — model opencode-go/hy3 at temperature 0.3
- Task complexity classification and cost-aware routing in lead-dev
- Interactive install.sh with API key setup and existing config detection
- devops-specialist agent for CI/CD and IaC
- monitoring-specialist agent for observability stack
- feat: add MCP servers (shadcn, 21st-dev-magic, chrome-devtools) to opencode.jsonc
- feat: add `web-design-guidelines` skill (vendored from vercel-labs/agent-skills, MIT)
- feat: add `diagnosing-bugs` (core) and `writing-for-agents` (swarm pack, loaded by swarm-architect) skills (vendored from mattpocock/skills, MIT)
- feat: add `seo-specialist` agent (model: opencode-go/deepseek-v4-pro) and `seo-engineering` skill (practical recipes, JSON-LD cheat sheet, per-framework sitemaps)

### Changed
- 2026-10-18: `install.sh` with no flag now installs only the CLIs found on `PATH` (it used to install all three), picks a hybrid or slim profile and prints it with the command to run; `--hybrid` / `--slim` override. MCP servers are opt-in: `--mcp`, or one question on a terminal. Without it OpenCode gets an `opencode.jsonc` copy without the `mcp` block (rerun with `--mcp` to get the link back); servers already registered are left alone. The slim profile skips the swarm pack agents and the `hybrid-delegate`, `swarm-handoff`, `git-workflow` and `writing-for-agents` skills.
- Consolidated config to single git repo with symlinks
- Updated all agent models to correct configurations
- Enhanced lead-dev with smart routing for cost optimization
- Simplified install.sh to focus on opencode-go and nvidia providers

### Fixed
- `linkedin-specialist` registered in `lead-dev.md` approved-subagents and routing tables, and in README install lists (it was added in a previous commit without registration)
- Removed duplicate node_modules and backup files
- Fixed absolute paths for portability
- Updated README with correct agent/skill counts
- fix: move gemini-mcp-tool from mcp.json (Claude format) into opencode.jsonc `mcp` key (opencode format) — was not actually being loaded

## [Initial Release]

### Added
- 17 specialized agents for different domains
- 15 custom skills
- Portable install script
- Consolidated config structure with symlinks
