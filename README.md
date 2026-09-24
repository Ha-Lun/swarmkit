# SwarmKit 🐝

**A multi-agent specialist swarm and modular skills for Claude Code, OpenCode, and Antigravity, all built from one source.**

You write every agent, skill and rule once in `core/`. A small compiler turns them into each CLI's native format. The installer links the results into place. All three CLIs get the same team: 33 specialists, shared working rules, quality gates, and the always-on anti-over-engineering discipline.

---

## ⚙️ How it works

- **The main agent does the work and delegates when a task clearly belongs to a specialist.** Small edits happen directly. Domain work (UI, APIs, databases, infrastructure) goes to the matching specialist.
- **Tiered routing:**
  - **T0** questions and reviews: answered directly
  - **T1** trivial edits (typos, renames, version bumps): done directly, with no plan and no gate
  - **T2** contained domain work: plan, your approval, then execution
  - **T3** cross-cutting work: same as T2, in an isolated git worktree
- **Quality gates run only when relevant:** `security-auditor` when auth, secrets or input handling changed; `code-proofreader` and `git-specialist` on large diffs; `release-tester` if tests weren't run; `seo-worker` after website builds.
- **Worktrees are never merged or removed without your explicit instruction.**
- **`lead-dev`** is an optional pure orchestrator for big multi-specialist jobs (`claude --agent lead-dev`, or the `lead-dev` primary agent in OpenCode).

## 🧩 One source, three CLIs

| | Claude Code | OpenCode | Antigravity |
|---|---|---|---|
| Specialists | Subagents in `~/.claude/agents/` | Agents in `~/.config/opencode/agents/` | Skills in the `swarmkit` plugin (Antigravity has no custom subagents) |
| Rules | `~/.claude/CLAUDE.md` | `~/.config/opencode/AGENTS.md` | Plugin `rules/AGENTS.md` |
| Tool limits | Enforced (`tools:` and `guard.py` hooks) | Enforced (`permission:` blocks) | Stated in each specialist skill |
| Skills | `~/.claude/skills/` | `~/.config/opencode/skills/` | `~/.gemini/config/skills/` |
| MCP servers | Registered with `claude mcp add-json` | `opencode.jsonc` | `~/.gemini/config/mcp_config.json` |

Each agent has a **tier** (`fast`, `standard`, `deep`). The model for each tier is set once per CLI in `scripts/build.py`:

| Tier | Claude Code | OpenCode | Used for |
|---|---|---|---|
| fast | `haiku` | muse-spark-1.3 | explore, junior-dev, git-specialist, release-tester, showroom-asset-processor |
| standard | `sonnet` | nemotron-3.5-lightning | most specialists |
| deep | `opus` | nemotron-3-ultra | db-specialist, security-auditor, swarm-architect, lead-dev |

## ✨ Key features

- **Doer, not advisor.** Agents carry out the fix instead of describing what you should do.
- **Isolation for risky work.** Heavy, multi-file changes run in `.worktrees/<branch>`, and your main branch stays clean until you merge.
- **Ponytail discipline.** An always-on anti-over-engineering system with `lite`, `full` and `ultra` modes.
- **Project-type routing.** Detects Lovable, Capacitor, Electron, n8n and Cloudflare projects and routes to the right specialist.
- **Cost-aware models.** Cheap models for mechanical work, strong models only where mistakes are expensive.
- **MCP servers.** Playwright, Chrome DevTools, Firecrawl, Blender, Google Search Console, Google Trends, shadcn, 21st.dev, Gemini, and the Cloudflare suite.
- **20+ shared skills.** Frontend and backend quality, git workflow, security review, premium frontend system, SEO engineering, n8n API and debugging, Capacitor mobile quality, curated resources, and more.
- **Slash commands (OpenCode).** `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-help`, and `/ponytail lite|full|ultra|off`.

## 🤖 Agent roster

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

The installer symlinks everything into each CLI's config directory. Anything it replaces is first backed up to `~/.opencode-backup-<timestamp>/`. You can run it again safely; a second run changes nothing.

### Installer flags

| Flag | Description |
|---|---|
| `--claude` | Install the Claude Code config (rules, agents, hooks, skills, MCP servers) |
| `--opencode` | Install the OpenCode config (rules, agents, commands, skills, `opencode.jsonc`) |
| `--agy` | Install the Antigravity config (`swarmkit` plugin, skills, MCP servers) and `agyw` |
| `--all` | `--claude`, `--opencode` and `--agy`. This is also the default when no flag is given. |
| `--n8n` | Configure self-hosted n8n credentials (not included in `--all`) |
| `--cloudflare` | Install Cloudflare skills and authenticate (not included in `--all`) |
| `--free` | OpenCode free mode: copies `opencode.jsonc` with a free default model |
| `--uninstall` | Remove every link that points into this repo |
| `--help` | Show the help message |

### Updating an existing install

```bash
cd swarmkit
git pull
./install.sh --all      # or only the flags for the CLIs you use on this machine
```

Always rerun the installer after pulling. It relinks moved files and removes links left over from older layouts.

## 🛠️ Customising the swarm

```
core/
  agents/        agents in CLI-neutral format   ← edit
  skills/        shared skills                  ← edit
  rules/AGENTS.md  shared rules                 ← edit
  mcp.json       MCP servers (Claude Code, Antigravity)
claude/          rules.md addendum, hooks/, and generated agents/ + CLAUDE.md
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
capabilities: [read, edit, bash]
opencode:                 # passed to OpenCode as-is
  mode: subagent
  permission: { ... }
claude:                   # Claude Code-only extras
  extra_tools: [mcp__playwright__*]
```

After editing anything in `core/` or a `rules.md` addendum:

```bash
python3 scripts/build.py   # needs PyYAML
```

Commit the sources and the generated files together. Never edit the generated `agents/`, `CLAUDE.md`, `AGENTS.md` or `plugins/swarmkit/` directly.

## 🔗 Linking Your Own Self-Hosted n8n

SwarmKit supports orchestrating external workflows securely using **n8n**. We use this heavily for external AI pipelines without exposing API endpoints directly in your project.

To link your own self-hosted n8n securely:
1. Run `./install.sh --n8n`
2. Enter your n8n API URL and API Key when prompted.

**🔒 Privacy & Security Guarantee**: 
- **Zero hardcoded credentials**: No personal URLs, Tailscale hostnames, or API keys are committed to Git.
- **Local-only config**: Endpoints reside strictly in `~/.config/swarmkit/n8n.env` (or your shell profile) making them accessible only to the running agent on your local machine.

## 🔄 Multi-account switching (agyw)

`agyw` is installed automatically as part of `--agy` or `--all`. It lets you switch between multiple Google accounts in `agy` without logging out.

`agyw` manages isolated profiles stored in `~/.agyw/profiles/`. Each profile has its own copy of OAuth credentials and private config. Switching profiles swaps a single symlink (`~/.gemini/antigravity-cli/`) to point at a different profile directory — so the next `agy` command runs as a completely different account with zero re-login required (as long as you've already authenticated that profile once).

> **Already have SwarmKit installed?** Run these two commands directly — no need to re-run the full installer:
> ```sh
> npm install -g agyw && agyw init
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
- **`showroom`**: Orchestrates premium, scroll-driven, dark-theme product detail pages using Astro, Tailwind, GSAP, Lenis, and human-in-the-loop Google Flow assets.
- Includes peer workers: `showroom-intake`, `showroom-art-director`, `showroom-asset-processor`, `showroom-frontend-builder`, `showroom-motion-engineer`.
