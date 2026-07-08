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

Drop the contents into `~/.config/opencode/`:

```bash
cd ~/.config/opencode
git clone https://github.com/Ha-Lun/opencode-config.git .
```

Or cherry-pick what you want.

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
