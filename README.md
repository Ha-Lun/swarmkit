# SwarmKit 🐝

**Production-grade multi-agent specialist swarm & modular skills for OpenCode, Antigravity, and Claude Code.**

A portable, self-contained **multi-agent swarm configuration** for [opencode](https://opencode.ai), Antigravity, and Claude Code. Run the unified installer to get a full development team across OpenCode, Antigravity, and Claude Code: an orchestrator that plans, tiered routing that picks the right specialist, quality gates before every commit, and an always-on anti-over-engineering system. All pre-wired and ready to go.

---

## ⚙️ How it works

SwarmKit runs as an **orchestrator + specialist swarm**:

- **`lead-dev` is the brain.** It plans, routes, and dispatches — but never touches files or runs the shell. It's the only agent that can spawn subagents.
- **23 specialist agents do the actual work.** They read code, edit code, run commands, and review results in their domain.
- **Every non-trivial task flows through:** `explore → plan → approve → worktree → execute → quality gate`.
- **Tiered complexity routing:**
  - **Trivial** (typos, renames, config tweaks) → `junior-dev` — fast and cheap
  - **Moderate** (UI work, APIs, Docker, deployments) → domain specialists
  - **Complex or risky** → senior specialists + security review

## ✨ Key features

- **Doer, not advisor** — agents execute fixes, they don't lecture you about what to do
- **Worktree isolation** — every non-trivial change gets its own git worktree; your main branch stays clean until a change is approved
- **Quality gates** — security audit, code proofreading, and release testing all run before a change ships
- **Ponytail discipline** — an always-on anti-over-engineering system with `lite` / `full` / `ultra` modes
- **Project-type routing** — auto-detects Lovable, Capacitor, Electron, and Next.js projects and dispatches the right specialist
- **Cost-aware routing** — cheap models for trivial tasks, smart models for complex work
- **4 MCP servers** — Gemini (compute offload), shadcn (UI components), 21st.dev (AI-generated components), Chrome DevTools (browser automation)
- **18+ skills** — frontend quality, backend quality, git workflow, security review, premium frontend system, web design guidelines, SEO engineering, n8n API & debugging, and more
- **5 slash commands** — `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`, `/ponytail-help`, and `/ponytail lite|full|ultra|off`

## 🤖 Agent roster

### Orchestrator

| Agent | Role |
|---|---|
| **lead-dev** | Primary orchestrator — plans, dispatches to specialists, synthesizes results. No file I/O, no shell. |

### Context & Git

| Agent | Role |
|---|---|
| **explore** | Read-only context gathering pre-flight |
| **git-specialist** | Git operations, worktree management, commit review |

### Execution — Tier 1 (trivial)

| Agent | Role |
|---|---|
| **junior-dev** | Quick mechanical edits, typo fixes, simple renames |

### Execution — Tier 2–3 (domain specialists)

| Agent | Role |
|---|---|
| **frontend-specialist** | Production-ready UI, design quality, accessibility |
| **animation-specialist** | 2D/3D animation (Motion, GSAP, Three.js, R3F) |
| **backend-specialist** | APIs, services, auth, data, observability |
| **db-specialist** | Schema design, migrations, query optimization |
| **devops-specialist** | CI/CD, infrastructure as code, deployment |
| **docker-specialist** | Containerization, Dockerfiles, Compose stacks |
| **server-specialist** | Ubuntu server admin, systemd, nginx, security |
| **monitoring-specialist** | Prometheus, Grafana, Loki, alerting, APM |
| **lovable-specialist** | Frontend edits in Lovable-made projects |
| **android-capacitor-specialist** | Capacitor Android builds, Play Store |
| **ios-capacitor-specialist** | Capacitor iOS builds, App Store |
| **electron-specialist** | Desktop app packaging (electron-builder/forge) |
| **n8n-workflow-builder** | Build n8n workflows (Telegram, integrations) |
| **n8n-debugger** | Debug broken n8n workflows |
| **seo-specialist** | Technical SEO, structured data, AI search |
| **linkedin-specialist** | LinkedIn content creation |

### Quality & Review

| Agent | Role |
|---|---|
| **security-auditor** | Security review, vulnerability scanning |
| **code-proofreader** | Dead code, unused exports, over-engineering |
| **release-tester** | Tests, lint, typecheck, build validation |
| **test-writer** | Unit and integration test generation |

## 🚀 Installation

Clone the repository anywhere and run the unified installer:

```bash
git clone https://github.com/Ha-Lun/swarmkit.git
cd swarmkit
./install.sh --all
```

### Quickstart Guide

The `./install.sh` script is a unified setup tool that supports installing configurations for OpenCode, Antigravity (`agy`), and Claude Code. You can run it with flags to selectively install or configure the swarm.

### Installer Flags

| Flag | Description |
|---|---|
| `--opencode` | Install OpenCode config (agents, skills, opencode.jsonc) |
| `--agy` | Install Antigravity (agy) Swarm config |
| `--claude` | Install Claude Code Swarm config |
| `--all` | Install all of the above |
| `--free` | Enable free mode for OpenCode (uses default models, no API keys needed) |
| `--uninstall` | Uninstall all configurations |
| `--help` | Show the help message |
