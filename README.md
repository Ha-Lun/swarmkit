# opencode-config

My personal opencode configuration — agents, commands, skills, and main config.
Self-contained, portable, designed to be cloned into `~/.config/opencode/` on a fresh install.

## What's in here

- `opencode.jsonc` — main config (providers, permissions, plugin list)
- `agents/` — custom agents
- `command/` — slash commands (ponytail family)
- `plugins/` — JS plugins
- `skill/` — skill definitions
- `package.json` / `package-lock.json` — opencode plugin dependencies

````markdown
## Install

This config spans two locations on the machine:

- `~/.config/opencode/` — `opencode.jsonc` config, plugins, ponytail command/skill symlinks, `package.json`
- `~/.opencode/` — the 19 specialist agents and 14 skills that drive the swarm

If opencode is already installed, both directories may exist and be non-empty. Pick one of the two flows below.

### A. Replace existing config (clean install of this repo)

Back up both locations, then clone into the now-empty config dir:

```bash
mv ~/.config/opencode ~/.config/opencode.bak.$(date +%s)
mv ~/.opencode ~/.opencode.bak.$(date +%s)
git clone https://github.com/Ha-Lun/opencode-config.git ~/.config/opencode
mkdir -p ~/.opencode/agents ~/.opencode/skills
cp ~/.config/opencode/agents/{lead-dev,explore,security-auditor,code-proofreader,frontend-specialist,animation-specialist,linkedin-specialist,lovable-specialist,backend-specialist,db-specialist,release-tester,test-writer,git-specialist,junior-dev}.md ~/.opencode/agents/
for d in backend-quality design-taste-frontend frontend-design-baseline frontend-quality git-workflow premium-frontend-system release-testing security-review swarm-handoff; do
  cp -r ~/.config/opencode/skill/"$d" ~/.opencode/skills/
done
cd ~/.config/opencode && npm install
```

To roll back: `rm -rf ~/.config/opencode ~/.opencode && mv ~/.config/opencode.bak.<ts> ~/.config/opencode && mv ~/.opencode.bak.<ts> ~/.opencode`

### B. Merge with existing config (keep your current `opencode.json`)

Clone to a temp dir, then copy files in without overwriting anything:

```bash
git clone https://github.com/Ha-Lun/opencode-config.git /tmp/opencode-config
cp -rn /tmp/opencode-config/. ~/.config/opencode/
mkdir -p ~/.opencode/agents ~/.opencode/skills
cp -rn /tmp/opencode-config/agents/{lead-dev,explore,security-auditor,code-proofreader,frontend-specialist,animation-specialist,linkedin-specialist,lovable-specialist,backend-specialist,db-specialist,release-tester,test-writer,git-specialist,junior-dev}.md ~/.opencode/agents/
for d in backend-quality design-taste-frontend frontend-design-baseline frontend-quality git-workflow premium-frontend-system release-testing security-review swarm-handoff; do
  cp -rn /tmp/opencode-config/skill/"$d" ~/.opencode/skills/
done
cd ~/.config/opencode && npm install
```

Diff your old config against the new one and merge the bits you want:

```bash
diff ~/.config/opencode.bak.<timestamp>/opencode.json ~/.config/opencode/opencode.json
```

After either path, restart opencode so it picks up the new config.
````

## Path conventions

Any path that was machine-specific has been rewritten to use `$HOME/...` (POSIX) — substitute your actual paths in `opencode.jsonc` and `plugins/gk-hooks.js` if you don't use the same layout. Default assumes:

- `$HOME/tools/ponytail/` — the ponytail tool (if you use the bundled skill files)
- `$HOME/.local/share/GitKrakenCLI/versions/gk_3_1_68/` — GitKraken CLI

## What's NOT here

- `antigravity-accounts.json` — contains live auth tokens, never committed
- `node_modules/` — run `npm install` to reproduce

## Requirements

- opencode (tested with current stable)
- Node.js + npm (for `npm install` to fetch `@opencode-ai/plugin`)

## License

MIT. See `LICENSE`.
