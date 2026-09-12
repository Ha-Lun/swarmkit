# SwarmKit 🐝

**Production-grade multi-agent specialist swarm & modular skills for OpenCode, Antigravity, and Claude Code.**

A portable, self-contained **multi-agent swarm configuration** for [opencode](https://opencode.ai), Antigravity, and Claude Code. Run the unified installer to get a full development team across OpenCode, Antigravity, and Claude Code: an orchestrator that plans, tiered routing that picks the right specialist, quality gates before every commit, and an always-on anti-over-engineering system. All pre-wired and ready to go.

---

## ⚙️ How it works

SwarmKit runs as an **orchestrator + specialist swarm**:

- **`lead-dev` is the brain.** It plans, routes, and dispatches — but never touches files or runs the shell. It's the only agent that can spawn subagents.
- **23 specialist agents do the actual work.** They read code, edit code, run commands, and review results in their domain.
- **Every non-trivial task flows through:** `explore → stateful execute (plan & test internally) → parallel quality gate`.
- **Tiered complexity routing:**
  - **Trivial** (typos, renames, config tweaks) → `junior-dev` — fast and cheap
  - **Moderate** (UI work, APIs, Docker, deployments) → domain specialists
  - **Complex or risky** → senior specialists + security review

## ✨ Key features

- **Doer, not advisor** — agents execute fixes, they don't lecture you about what to do
- **Native isolation** — every non-trivial change gets an automatically branched workspace; your main branch stays clean until a change is approved
- **Quality gates** — security audit, code proofreading, and release testing all run before a change ships
- **Ponytail discipline** — an always-on anti-over-engineering system with `lite` / `full` / `ultra` modes
- **Project-type routing** — auto-detects Lovable, Capacitor, Electron, and Next.js projects and dispatches the right specialist
- **Cost-aware routing** — cheap models for trivial tasks, smart models for complex work
- **7 MCP servers** — Gemini (compute offload), shadcn (UI components), 21st.dev (AI-generated components), Chrome DevTools (browser automation), Firecrawl (markdown crawling), Google Search Console (SEO metrics), and Google Trends (keyword data)
- **19+ skills** — frontend quality, backend quality, git workflow, security review, premium frontend system, web design guidelines, SEO engineering, n8n API & debugging, curated resources (scrapeling, public-apis, awesome lists, etc.), and more
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
| `--colab` | Install and authenticate google-colab-cli |
| `--n8n` | Configure local self-hosted n8n credentials |
| `--all` | Install all of the above |
| `--free` | Enable free mode for OpenCode (uses default models, no API keys needed) |
| `--uninstall` | Uninstall all configurations |
| `--help` | Show the help message |

## 🔗 Linking Your Own Self-Hosted n8n

SwarmKit supports orchestrating external workflows securely using **n8n**. We use this heavily for external AI pipelines without exposing API endpoints directly in your project.

To link your own self-hosted n8n securely:
1. Run `./install.sh --n8n`
2. Enter your n8n API URL and API Key when prompted.

**🔒 Privacy & Security Guarantee**: 
- **Zero hardcoded credentials**: No personal URLs, Tailscale hostnames, or API keys are committed to Git.
- **Local-only config**: Endpoints reside strictly in `~/.config/swarmkit/n8n.env` (or your shell profile) making them accessible only to the running agent on your local machine.

### 🎨 3D Animation Pipeline (Wan 2.1)

SwarmKit includes a production-grade 3D camera turnaround pipeline powered by **Wan 2.1** (1.3B / 14B), automated frame extraction, super-resolution upscaling, and an Apple-grade interactive canvas scrubber.

#### 1. Execution Modes

- **Mode 1: Headless Colab CLI (Automated)**  
  Run single-command headless generation that provisions a Colab GPU, generates the turnaround video, downloads the MP4, and extracts frames:
  ```bash
  ./scripts/trigger-3d-animation.sh \
    --prompt "luxury Swiss premium chronograph watch, rose gold casing, sapphire crystal, rotating turntable, studio lighting, photorealistic 8k" \
    --camera orbit_360 \
    --steps 15 \
    --frames 49 \
    --resolution 640x360 \
    --upscale 2560x1440
  ```
  Run `./install.sh --colab` to set up the CLI. See [COLAB_CLI_3D_PIPELINE.md](docs/COLAB_CLI_3D_PIPELINE.md) for full instructions.

- **Mode 2: Colab Web UI Notebook (Interactive / Heavy Models)**  
  For interactive runs or when using larger GPUs (A100/L4/T4), use [`notebooks/wan2_colab_worker.ipynb`](notebooks/wan2_colab_worker.ipynb). It features 1-click Google Drive (2TB) model caching (`HF_HOME`) and A100/T4 acceleration.

- **Mode 3: n8n Webhook (Optional Automation)**  
  For external triggers (e.g., Discord bots) or advanced workflows, you can route generations through an n8n webhook which acts as the orchestrator.

#### 2. Super-Resolution Upscaling (1440p / 4K)

The pipeline integrates automated super-resolution frame post-processing:
- **Lanczos scaling with unsharp masking**: High-quality scaling that preserves fine mechanical details, metallic facets, and micro-textures.
- **QHD Retina (`2560x1440`) & 4K (`3840x2160`)**: Outputs crisp WebP frames with progressive preloading and auto-generated `manifest.json`.

#### 3. Interactive Swiss Horology Showcase Website

Experience the turnaround in a standalone, Apple-grade product showcase:
- **Local & Tailscale Access**: Served at `http://localhost:8081` and accessible over private mesh networks at `http://<tailscale-ip>:8081`.
- **Ultra-Smooth 60fps Lerp Loop**: Canvas scrubber with inertia, momentum scrolling, and touch/drag controls.
- **360° Compass HUD Telemetry**: Real-time azimuth degree tracking and dynamic frame indexing.
- **Floating Narrative Cards & Specifications Bento Grid**: Contextual storytelling that adapts dynamically to viewing angles.
- **Web Audio Precision Ticking Sound**: Procedural mechanical watch escapement audio synchronized with user interaction.

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

