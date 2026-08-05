---
name: strix
description: AI-driven penetration testing via the strix CLI. Use ONLY when the user explicitly requests dynamic security testing, exploitation validation, PoC generation, or authorized red-team assessment of a target (local repo, GitHub URL, live URL, OpenAPI spec, or PR diff). Triggers on "pentest", "penetration test", "strix", "exploit PoC", "security validation", "run strix on". Requires Docker + a paid LLM key — do not invoke without confirmation that the environment is set up. Do NOT use for static code review (use security-review skill instead).
---

# strix

## When to use

- Authorized dynamic security testing of an app the user owns.
- Validating whether a suspected vulnerability is exploitable end-to-end.
- PR-diff security scoping (`--scope-mode diff --diff-base origin/main`).
- OpenAPI / Postman / live-URL surface testing.

Do NOT use for:

- Static code review → use the `security-review` skill.
- Linting / dependency scanning → use `security-auditor` agent.
- Quick checklist audits → use `security-auditor` agent.

## Prerequisites (one-time setup)

1. **Docker daemon** running. Verify with `docker info`.
2. **LLM API key** in shell env. Pick ONE:

   - `STRIX_LLM="openai/gpt-5.4"` + `LLM_API_KEY=<key>` for OpenAI
   - `STRIX_LLM="anthropic/claude-sonnet-4-6"` + `ANTHROPIC_API_KEY=<key>` for Anthropic
   - `STRIX_LLM="vertex_ai/gemini-3-pro"` + Google ADC for Vertex

   Strix reads these via litellm; see https://strix.ai/docs for the full provider list.

3. **Install strix:** `pip install strix-agent` (or `curl -sSL https://strix.ai/install | bash`).
4. **Authorize scope:** confirm with the user the target is theirs to test. Strix will issue a warning otherwise.

## Invocation patterns

Wrap via the `strix-pentester` subagent (preferred for non-trivial scopes) or call directly:

```bash
# Local repo, full scan
strix -n --target ./path/to/app --instruction-file rules.md --scan-mode standard

# GitHub URL
strix -n --target https://github.com/owner/repo --instruction-file rules.md

# Live URL
strix -n --target https://example.com --instruction-file rules.md --scan-mode quick

# OpenAPI spec
strix -n --target ./openapi.yaml --instruction-file rules.md

# PR diff scoping
strix -n --target ./app --scope-mode diff --diff-base origin/main
```

Flags you'll use most:
- `-n` / `--non-interactive` — headless; required for agent use.
- `--target` — local path, GitHub URL, live URL, or OpenAPI/Postman file.
- `--instruction-file` — rules of engagement; write it before the run.
- `--scan-mode standard|quick` — `quick` for time-boxed recon.
- `--scope-mode diff --diff-base <ref>` — PR-diff scoping.
- `--target-list` — multiple targets.

## Output handling

- Reports land in `./strix_runs/<run-name>/` (cwd-relative; gitignore the parent).
- Files: `report.json` (machine-readable findings + CVSS), `report.md` (narrative), `strix_runs/<run-name>/artifacts/...` (PoC code, screenshots, request logs).
- `strix view` opens a local dashboard for a run (browser-based).

When summarizing back to the user, lead with: target, scope, scan mode, run duration, finding count by severity, top 3 CVSS findings, then the rest in a table.

## Rules of engagement (write this before each non-trivial run)

A minimal `rules.md`:

```markdown
# Rules of engagement

- Target: <path/URL/repo>
- Owner authorization: confirmed <yes/no>
- Out of scope: <list — e.g. production data, third-party services>
- Time budget: <e.g. 30 minutes>
- Data handling: <e.g. no exfiltration, dry-run only>
- Stop conditions: <e.g. any destructive action>
```

Strix reads this file; missing it triggers a warning.
