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

## Install

The target is `~/.config/opencode/`. If opencode is already installed on the
machine, that directory exists and is **not empty** — `git clone <url> .` will
refuse to run with `fatal: destination path '.' already exists and is not an
empty directory.`. Pick one of the two flows below.

### A. Replace existing config (clean install of this repo)

Back up what's there, then clone into the now-empty target:

```bash
mv ~/.config/opencode ~/.config/opencode.bak.$(date +%s)
git clone https://github.com/Ha-Lun/opencode-config.git ~/.config/opencode
cd ~/.config/opencode && npm install
```

To roll back: `rm -rf ~/.config/opencode && mv ~/.config/opencode.bak.<timestamp> ~/.config/opencode`

### B. Merge with existing config (keep your current `opencode.json`)

Clone to a temp dir, then copy files in without overwriting anything:

```bash
git clone https://github.com/Ha-Lun/opencode-config.git /tmp/opencode-config
cp -rn /tmp/opencode-config/. ~/.config/opencode/
cd ~/.config/opencode && npm install
```

Diff your old config against the new one and merge the bits you want:

```bash
diff ~/.config/opencode.bak.<timestamp>/opencode.json ~/.config/opencode/opencode.json
```

After either path, restart opencode so it picks up the new config.

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
