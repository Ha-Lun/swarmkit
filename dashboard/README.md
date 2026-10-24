# SwarmKit dashboard

A local web dashboard that starts, drives and watches **Claude Code** sessions through the
[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), showing a live tree
of the agents involved — the session, any spawned subagents and your agy/opencode worker tasks.
Terminal sessions already on disk (`~/.claude/projects/**/*.jsonl`) are picked up and merged into
the same view.

## Run it

```sh
cd dashboard
npm install
npm run build     # builds the UI into dist/
npm start         # serves the UI + API, prints the URL(s)
```

For development with hot reload: `npm run dev` (Vite middleware mode, no build needed).

Static demo (scripted mock backend, no server, relative paths): `npm run build:demo` → `dist-demo/`. The showcase site embeds it via `site/scripts/sync-dashboard-demo.sh` on the `showcase` branch.

Open the URL the server prints on startup, e.g.

```
SwarmKit: http://127.0.0.1:4317
SwarmKit: token: /home/you/.config/claude-fleet/token
```

The first visit with `?token=…` (printed on an interactive terminal — on a TTY only)
hands your browser a session cookie and redirects to the clean URL. You can also
`POST /api/auth` with `{"token": "…"}` (same-origin, rate-limited to 10 attempts
per minute per address) to get the cookie.

## Configuration (environment)

| Env            | Default                                                                    | Meaning                                                      |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `PORT`         | `4317`                                                                     | HTTP port                                                     |
| `HOST`         | `127.0.0.1`                                                                | Bind address (`0.0.0.0` also prints LAN URLs)                 |
| `FLEET_TOKEN`  | stored at `$XDG_CONFIG_HOME/claude-fleet/token` (default `~/.config/claude-fleet/token`, dir `0700`, file `0600`) | Shared token; must be **≥ 32 chars** when set |
| `FLEET_HOSTS`  | `127.0.0.1:<PORT>,localhost:<PORT>,ll-server.tail3e28e1.ts.net:<PORT>`      | Comma-separated Host allowlist; other Hosts get `421`         |
| `FLEET_OWNER`  | unset                                                                      | When set, requests carrying a different `tailscale-user-login` header are rejected with `403` (requests without the header, i.e. local access, pass) |

A legacy `dashboard/.data/token` is migrated to `$XDG_CONFIG_HOME/claude-fleet/token`
on start (the old file is deleted). `FLEET_TOKEN` is scrubbed from the environment
right after reading, so child agents never see it.

**Auth shapes.** The raw token is accepted via the `x-fleet-token` header and the
`?token=` URL. Browsers get a *derived* cookie value: `fleet_token` =
`HMAC-SHA256(token, 'fleet-cookie-v1')` base64url — the raw token never lives in a
cookie, so a leaked browser cookie is not the shared secret. POST/DELETE without an
`Origin` header are only accepted when authenticated by the `x-fleet-token` header,
not the cookie.

## API

`GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`POST /api/sessions/:id/message`, `POST /api/sessions/:id/interrupt`,
`DELETE /api/sessions/:id`, `POST /api/permissions/:id`, `GET /api/agents?cwd=…`,
`GET /api/cwds`, `GET /api/stars`, `POST /api/stars`, `POST /api/auth`, `GET /api/usage`, and `GET /events`
(server-sent events). Every
endpoint needs the token (cookie `fleet_token` or header `x-fleet-token`) except
`POST /api/auth`. See `src/shared/types.ts` for the shapes.

## Usage limits

`GET /api/usage` answers a `UsageReport` with one block per collector
(`claude`, `opencode`, `agy`); `?refresh=1` bypasses the collector caches
(honoured at most once per 30 s). Each collector runs on its own cache and
timeout and never fails the others — a failing one answers
`available: false` with a short `error` string.

- **Claude**: true plan limits (5-hour, 7-day, per-model weekly utilisation
  0-100 with ISO reset times) from the SDK's experimental usage call, used
  sparingly as a probe with a 5-minute cache. Between probes the report falls
  back to the latest `rate_limit_event` of any live session (`source: 'session'`).
  This relies on an unstable SDK API (`usage_EXPERIMENTAL_…`) that may change
  or disappear in any release.
- **OpenCode**: consumption only (tokens spent and estimated USD cost),
  derived from `opencode stats`. No plan limit is exposed for it.
- **agy**: consumption (tokens, runs, stopped from the worker task
  directories) plus real plan limits via `agy -p /usage --output-format json`
  (no agent turn, no quota spent): per-group `5h`/`weekly` utilisation 0-100
  with ISO reset times.

## Security headers

Every response carries `X-Frame-Options: DENY`, `Content-Security-Policy`
(default-src 'self' …, production only — dev omits it because Vite injects inline
scripts), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`;
`/api` and `/events` answers are `Cache-Control: no-store`. The dev server
(`vite.config.ts`) refuses to serve secret files: `.env*`, certificates/keys,
`.npmrc`, `.git/**` and `.data/**`.

## Workers panel

The dashboard lists every `agy-task` / `opencode-task` directory it finds under
`AGY_TASK_DIR` (default `~/.agy-tasks`) and `OPENCODE_TASK_DIR` (default
`~/.opencode-tasks`) — running tasks first (live denied-tool counts from the
opencode stream), then finished ones with their `result.json` verdict, elapsed
time, model and agent. `GET /api/workers` returns the list (`WorkerTask[]`),
`GET /api/workers/:lane/:repo/:slug/log` the last log lines, and a worker whose
slug matches a worker node in any known session tree is linked to that node
(`workers.update` events over `/events`, also sent right after `hello`).

## Folder picker

`GET /api/dirs?path=<abs>&hidden=1` lists the directories of `path` (default
`$HOME`) so the start form can pick a working directory. The server refuses
every path outside `$HOME` (including symlinks that would escape it), hides
dotfiles unless `hidden=1`, and never lists `node_modules`; git repositories
are flagged with `isGitRepo`.

Folders can be starred from the picker, and starred repos are listed first on the landing page. `GET /api/stars` returns the starred paths that still exist inside `$HOME`; `POST /api/stars` with `{"path": "<abs dir>", "starred": true|false}` sets one and returns the new list (`400` for a path outside `$HOME` or a missing boolean). Stars are stored in `$XDG_CONFIG_HOME/claude-fleet/starred.json` (default `~/.config/claude-fleet/starred.json`, mode `0600`, next to the token file), capped at 50 folders.

## Continue (resume)

`POST /api/sessions/:id/resume` continues an **ended** session — page-owned or
a terminal transcript picked up by the watcher — with a new prompt. The tree is
rebuilt from the existing transcript, the same session id is kept, and the
terminal session becomes page-owned (watched by the page from then on).
Page-owned sessions can continue immediately after Stop (the "transcript
recently modified" freshness check applies only to terminal sessions).
Refused with `409` while the session is still active (root running on the page,
or the transcript file modified within the last minute), `400` for bad input
(including a resume `cwd` that fails the same validation as the start path:
existing directory under `$HOME`), `404` for unknown ids. Sending/interrupting a
session whose process has ended answers `409 "Session has ended; use Continue"`.

## Project settings trust (untrusted projects)

The SDK normally reads `user`, `project` and `local` settings. For a project
directory that Claude Code has **not** marked trusted in `~/.claude.json`
(`projects[<cwd>].hasTrustDialogAccepted !== true`, checked for both the given and
the realpath of the cwd), the server silently degrades to `settingSources: ['user']`
so untrusted `settings.json` files in some repo you just started a session from can
not add hooks or run commands as you. Such sessions carry
`untrustedProject: true` in their `SessionSummary`.

## Run always-on (systemd user service + tailscale serve)

Run the service from a **pinned deployment worktree**, not from the development
checkout. One-time setup:

```sh
git -C /home/ha-lun/opencode-config branch fleet-live dashboard
git -C /home/ha-lun/opencode-config worktree add /home/ha-lun/apps/claude-fleet fleet-live
npm ci --prefix /home/ha-lun/apps/claude-fleet/dashboard
ln -sf /home/ha-lun/apps/claude-fleet/dashboard/deploy/claude-fleet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-fleet.service
```

Expose it to your tailnet only (never Funnel):

```sh
tailscale serve --bg --https=4317 http://127.0.0.1:4317
```

To update the service to the latest dashboard code (fast-forward only):

```sh
git -C /home/ha-lun/apps/claude-fleet merge --ff-only dashboard && systemctl --user restart claude-fleet
```

Undo with `tailscale serve --https=4317 off` and
`systemctl --user disable --now claude-fleet.service`.

## Security notes

- **Every API call is token-gated.** The token is generated on first start
  (`$XDG_CONFIG_HOME/claude-fleet/token`, dir mode `0700`, file mode `0600`, legacy
  `.data/token` migrated) or taken from `FLEET_TOKEN` (≥ 32 chars, scrubbed from the
  environment after reading).
- Startup logs never contain the token — only the token file path; the full
  `?token=` URL is printed on interactive terminals only.
- Browsers authenticate with the derived HMAC cookie, so a stolen cookie value is
  not the raw shared secret; `FLEET_OWNER` optionally pins the allowed
  Tailscale login; unexpected `Host` headers get `421`; state-changing requests
  need a matching `Origin` (or header-token auth).
- The dashboard drives **your own Claude Code login** — starts, prompts and tool runs bill to
  your account, at real cost.
- Tool permissions normally asked by Claude Code in the terminal are **approved in the dashboard
  page** instead. Read the tool input before clicking Allow; denying replies through the SDK.
- Pages are plain `node:http` (no express), and the server never writes outside its `.data`
  directory.
