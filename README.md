# SwarmKit 🐝

**A multi-agent specialist swarm and modular skills for Claude Code, OpenCode, and Antigravity, all built from one source.**

You write every agent, skill and rule once in `core/`. A small compiler turns them into each CLI's native format. The installer links the results into place. All three CLIs get the same team of 33 specialists and the same short working rules. In Claude Code only five core agents load globally; domain specialists come as opt-in per-project packs, so a default session costs little more than stock.

---

## ⚙️ How it works

- **The main agent does the work.** Small and medium work happens directly. Large or risky work (more than ~3 files, or auth, data, CI or infra) gets a plan and your approval first (Claude Code: plan mode, so `opusplan` plans on Opus). A non-interactive session states the plan and continues instead of waiting.
- **Delegation where it helps:** `explore` for wide read-only searches; `security-auditor`, `code-proofreader` or `release-tester` as an independent review after large changes. Domain specialists say in their descriptions when to use them.
- **`lead-dev`** is an optional pure orchestrator for big multi-specialist jobs (`claude --agent lead-dev`, or the `lead-dev` primary agent in OpenCode).

## 🧩 One source, three CLIs

| | Claude Code | OpenCode | Antigravity |
|---|---|---|---|
| Specialists | Core subagents in `~/.claude/agents/`, packs in `<project>/.claude/agents/` | Agents in `~/.config/opencode/agents/` | Agents in the `swarmkit` plugin (`invoke_subagent`) |
| Rules | `~/.claude/CLAUDE.md` | `~/.config/opencode/AGENTS.md` | Plugin `rules/AGENTS.md` |
| Tool limits | `tools:` enforced; `guard.py` hooks are a speed bump (see below) | Enforced (`permission:` blocks) | Stated in each agent's instructions |
| Skills | `~/.claude/skills/` (core), packs in `<project>/.claude/skills/` | `~/.config/opencode/skills/` | `~/.gemini/config/skills/` |
| MCP servers | Registered with `claude mcp add-json` | `opencode.jsonc` | `~/.gemini/config/mcp_config.json` |

Each agent has a **tier** (`fast`, `standard`, `deep`). The model for each tier is set once per CLI in `scripts/build.py`:

| Tier | Claude Code | OpenCode | Used for |
|---|---|---|---|
| fast | `haiku` | muse-spark-1.3 | explore, junior-dev, git-specialist, release-tester, showroom-asset-processor |
| standard | `sonnet` | nemotron-3.5-lightning | most specialists |
| deep | `opus` | nemotron-3-ultra | db-specialist, security-auditor, swarm-architect, lead-dev |

## ✨ Key features

- **Doer, not advisor.** Agents carry out the fix instead of describing what you should do.
- **Isolation for risky work.** `lead-dev` runs heavy, multi-file changes in `.worktrees/<branch>` (via `git-specialist`), and your main branch stays clean until you merge.
- **Ponytail discipline.** Simplicity is a core working rule; the `ponytail` skills add `lite`, `full` and `ultra` modes on demand.
- **Caveman mode.** Terse output that cuts tokens without losing technical detail: `caveman`, `caveman-commit`, `caveman-review`, `caveman-compress` and `caveman-help`. MIT skills vendored from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) v2.7.0 (`2fd153c`). `caveman-compress` needs the `claude` CLI or `ANTHROPIC_API_KEY`.
- **Project-type routing.** Specialist descriptions name their project markers (Lovable, Capacitor, Electron, n8n, Cloudflare), so the main agent picks the right one once the pack is linked.
- **Cost-aware models.** Cheap models for mechanical work, strong models only where mistakes are expensive.
- **MCP servers.** Playwright, Chrome DevTools, Firecrawl, Blender, Google Trends, shadcn, 21st.dev, Gemini, and the Cloudflare suite. Versions are pinned (no `@latest`), so a package can't change under you; bump them deliberately.
- **20+ shared skills.** Frontend and backend quality, git workflow, security review, premium frontend system, SEO engineering, n8n API and debugging, Capacitor mobile quality, curated resources, and more.
- **Slash commands (OpenCode).** `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-help`, and `/ponytail lite|full|ultra|off`.

## 🤖 Agent roster

In Claude Code, `--claude` installs the five quality and review agents below plus the `release-testing`, `security-review`, `caveman*`, `ponytail*` and `curated-resources` skills (the last three groups are slash-command only, so they cost no context). Everything else is a pack you link into a project with `./install.sh --pack <name> [project]`:

| Pack | Agents | Skills |
|---|---|---|
| `web` | frontend, animation, seo-specialist, seo-worker, lovable | frontend-quality, premium-frontend-system, seo-engineering, seo-sharing-pass, web-design-guidelines, scroll-craft |
| `backend` | backend, db | backend-quality |
| `ops` | devops, docker, server, monitoring | |
| `mobile` | android-capacitor, ios-capacitor, electron | capacitor-mobile-quality |
| `n8n` | n8n-workflow-builder, n8n-debugger | n8n-api, n8n-debugging |
| `creative` | blender, showroom + 5 workers, linkedin | showroom, img2threejs |
| `swarm` | swarm-architect, lead-dev, junior-dev, git-specialist | swarm-handoff, git-workflow |

OpenCode and Antigravity get every agent and skill globally.

**The guards are a speed bump, not a sandbox.** In Claude Code, `guard.py` blocks obvious writes (redirections, `rm`, `sed -i`, `--fix`), fetch-and-run commands (`npx <package>`, `npm install <package>`, `pnpm dlx`) and, for `test-writer`, edits outside test files (never a manifest such as `package.json` or `Makefile`) or outside the project. `npm`, `pnpm`, `yarn` and `bun` may only install, `test`, or run a script that exists in `package.json`. A guard error blocks the call. A test runner can still run any code in your project (a `test-writer` can write a test that does, then run it), and `git-specialist` keeps an unrestricted shell. Antigravity only gets a line of instructions. OpenCode's `permission:` blocks match edit paths and command prefixes but have none of the runner rules above (its `test-writer` shell is unrestricted).

### Orchestration, context and git

| Agent | Tier | Role |
|---|---|---|
| **lead-dev** | deep | Optional pure orchestrator: plans, dispatches, synthesises |
| **explore** | fast | Read-only context gathering before non-trivial work |
| **git-specialist** | fast | Worktrees, commit hygiene, branch state |
| **junior-dev** | fast | Batches of mechanical edits |

### Domain specialists

| Agent | Tier | Role |
|---|---|---|
| **frontend-specialist** | standard | Production-ready UI, design quality, accessibility |
| **animation-specialist** | standard | 2D/3D animation (Motion, GSAP, Three.js, R3F) |
| **blender-specialist** | standard | 3D modelling, mesh generation, asset staging |
| **backend-specialist** | standard | APIs, services, auth, data, observability |
| **db-specialist** | deep | Schema design, migrations, query optimisation |
| **swarm-architect** | deep | Changes to this swarm: agents, skills, MCP wiring |
| **devops-specialist** | standard | CI/CD, infrastructure as code, deployment |
| **docker-specialist** | standard | Containerisation, Dockerfiles, Compose |
| **server-specialist** | standard | Linux server admin, systemd, nginx, hardening |
| **monitoring-specialist** | standard | Prometheus, Grafana, Loki, alerting |
| **lovable-specialist** | standard | Frontend edits in Lovable-made projects |
| **android-capacitor-specialist** | standard | Capacitor Android builds, Play Store |
| **ios-capacitor-specialist** | standard | Capacitor iOS builds, App Store |
| **electron-specialist** | standard | Desktop app packaging |
| **n8n-workflow-builder** | standard | Build n8n workflows |
| **n8n-debugger** | standard | Debug broken n8n workflows |
| **seo-specialist** | standard | Technical SEO, structured data, AI search |
| **seo-worker** | standard | Post-build SEO and sharing pass |
| **linkedin-specialist** | standard | LinkedIn content |
| **showroom** + 5 workers | standard / fast | Scroll-driven product pages (see below) |

### Quality and review

| Agent | Tier | Role |
|---|---|---|
| **security-auditor** | deep | Security review, vulnerability scanning |
| **code-proofreader** | standard | Dead code, unused exports, over-engineering |
| **release-tester** | fast | Tests, lint, typecheck, build validation |
| **test-writer** | standard | Unit and integration tests |

## 🚀 Installation

```bash
git clone https://github.com/Ha-Lun/swarmkit.git
cd swarmkit
./install.sh --all
```

The installer symlinks everything into each CLI's config directory. The agents and command directories are real directories holding one link per file, so files you add there are left alone (a name you already use is skipped and reported). Anything it replaces is first backed up to `~/.opencode-backup-<timestamp>/`. You can run it again safely; a second run changes nothing.

### Installer flags

| Flag | Description |
|---|---|
| `--claude` | Install the Claude Code config (rules, core agents, hooks, core skills, MCP servers). Removes the old `plan-gate.py` hook entry from `~/.claude/settings.json` if present |
| `--pack <name> [project]` | Link a Claude Code pack's agents and skills into `<project>/.claude/` (default: current dir) and list the links in the repo's `.git/info/exclude`. Packs: `web`, `backend`, `ops`, `mobile`, `n8n`, `creative`, `swarm`. With `--uninstall`, removes that pack from the project |
| `--opencode` | Install the OpenCode config (rules, agents, commands, skills, `opencode.jsonc`) |
| `--agy` | Install the Antigravity config (`swarmkit` plugin, skills, MCP servers) and `agyw` |
| `--all` | `--claude`, `--opencode` and `--agy`. This is also the default when no flag is given. |
| `--n8n` | Configure self-hosted n8n credentials (not included in `--all`) |
| `--cloudflare` | Install Cloudflare skills and authenticate (not included in `--all`) |
| `--free` | OpenCode free mode: copies `opencode.jsonc` with a free default model |
| `--uninstall` | Remove every global link that points into this repo and any old plan-gate entry in `~/.claude/settings.json` |
| `--help` | Show the help message |

### Updating an existing install

```bash
cd swarmkit
git pull
./install.sh --all      # or only the flags for the CLIs you use on this machine
```

Always rerun the installer after pulling. It relinks moved files and removes links left over from older layouts. With per-file links a new agent only appears after the rerun. MCP servers that are already registered are skipped, so an existing install keeps its old registrations: to adopt the pinned versions, `claude mcp remove <name> -s user` and rerun.

## 🛠️ Customising the swarm

```
core/
  agents/        agents in CLI-neutral format   ← edit
  skills/        shared skills                  ← edit
  rules/AGENTS.md  shared rules                 ← edit
  mcp.json       MCP servers (Claude Code, Antigravity)
claude/          rules.md addendum, hooks/, and generated agents/ (core), packs/ + CLAUDE.md
opencode/        rules.md addendum, opencode.jsonc, command/, and generated agents/ + AGENTS.md
antigravity/     rules.md addendum and the generated plugins/swarmkit/
scripts/build.py the compiler (and the tier → model table)
```

An agent's frontmatter holds the shared fields plus optional per-CLI overrides:

```yaml
name: backend-specialist
description: ...
role: specialist          # orchestrator | specialist | reviewer
tier: standard            # fast | standard | deep
pack: backend             # core | web | ops | mobile | n8n | backend | creative | swarm (Claude Code only)
capabilities: [read, edit, bash]
opencode:                 # passed to OpenCode as-is
  mode: subagent
  permission: { ... }
claude:                   # Claude Code-only extras
  description: ...        # optional; replaces the shared description
  extra_tools: [mcp__playwright__*]
antigravity:              # optional; falls back to claude, then shared description
  description: ...
```

A file at `core/agents/claude/<name>.md` or `core/agents/opencode/<name>.md` replaces that agent's body in that CLI's build only (used by `lead-dev`).

After editing anything in `core/` or a `rules.md` addendum:

```bash
python3 scripts/build.py   # needs PyYAML
```

Commit the sources and the generated files together. Never edit the generated `agents/`, `claude/packs/`, `CLAUDE.md`, `AGENTS.md` or `plugins/swarmkit/` directly.

## ✅ Benchmark

`python3 bench/run.py` checks the whole config offline and for free: build in sync, the same roster in every CLI, delegation wording, foreign tool names, guard hook behaviour, and each CLI's native validator. Add `--live claude|agy|opencode --yes` to send real prompts and score which specialist each CLI actually dispatches, and (Claude) whether it enters plan mode first for large work. See [bench/README.md](bench/README.md).

## 🔗 Linking Your Own Self-Hosted n8n

SwarmKit supports orchestrating external workflows securely using **n8n**. We use this heavily for external AI pipelines without exposing API endpoints directly in your project.

To link your own self-hosted n8n securely:
1. Run `./install.sh --n8n`
2. Enter your n8n API URL and API Key when prompted.

**🔒 Privacy & Security Guarantee**: 
- **Zero hardcoded credentials**: No personal URLs, Tailscale hostnames, or API keys are committed to Git.
- **Local-only config**: Endpoints reside strictly in `~/.config/swarmkit/n8n.env` (or your shell profile) making them accessible only to the running agent on your local machine.

## 🧭 Delegating to agy from Claude Code

`agy-task` runs one headless `agy` task on its own git worktree and branch `agy/<slug>`,
then writes `result.json`. The `agy-delegate` skill tells Claude when to use it—such
as for an independent diff review by a second model or bulk edits on separate
quota without consuming Claude tokens.

Tasks are managed with the `start`, `resume`, `list`, and `clean` commands. You can
launch an advisory review task in the background with `--review`:

```bash
agy-task start diff-review "Review the auth refactor for regressions" --review
```

By default, tasks are edit-only so `agy` cannot run shell commands, meaning Claude
must run tests itself in the worktree before merging. While a `--yolo` flag exists
to permit shell commands, it is unsandboxed. Once verified, merge `agy/<slug>`
and clean the worktree.

## 🔄 Multi-account switching (agyw)

`agyw` is installed automatically as part of `--agy` or `--all`. It lets you switch between multiple Google accounts in `agy` without logging out.

`agyw` manages isolated profiles stored in `~/.agyw/profiles/`. Each profile has its own copy of OAuth credentials and private config. Switching profiles swaps a single symlink (`~/.gemini/antigravity-cli/`) to point at a different profile directory — so the next `agy` command runs as a completely different account with zero re-login required (as long as you've already authenticated that profile once).

> **Already have SwarmKit installed?** Run these two commands directly — no need to re-run the full installer:
> ```sh
> npm install -g agyw@0.2.1 && agyw init
> ```

```sh
agyw add work          # Create a new profile (clears auth for fresh login)
agy auth login         # Log in with your work Google account
agyw switch default    # Switch back to your personal account
agyw list              # List all profiles
agyw status            # Check active profile + symlink health
```

> **Important:** Quit any running `agy` or Antigravity IDE processes before switching profiles.

## 🎬 Showroom Specialist Swarm
- **`showroom`**: Coordinates premium, scroll-driven, dark-theme product detail pages using Astro, Tailwind, GSAP, Lenis, and human-in-the-loop Google Flow assets. A subagent can't spawn subagents, so at each step it returns a `## DISPATCH: <worker>` handoff and the main agent (or `lead-dev`) dispatches that worker.
- Peer workers: `showroom-intake`, `showroom-art-director`, `showroom-asset-processor`, `showroom-frontend-builder`, `showroom-motion-engineer`.
