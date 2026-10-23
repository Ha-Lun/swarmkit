# Claude Fleet

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

Open the URL the server prints on startup, e.g.

```
Claude Fleet: http://localhost:4317/?token=m4BF...
```

The first visit with `?token=…` hands your browser a session cookie and redirects to the clean URL.

## Configuration (environment)

| Env          | Default     | Meaning                                            |
| ------------ | ----------- | -------------------------------------------------- |
| `PORT`       | `4317`      | HTTP port                                          |
| `HOST`       | `127.0.0.1` | Bind address (`0.0.0.0` also prints LAN URLs)      |
| `FLEET_TOKEN`| generated   | Shared token; stored in `.data/token` otherwise    |

## API

`GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`POST /api/sessions/:id/message`, `POST /api/sessions/:id/interrupt`,
`DELETE /api/sessions/:id`, `POST /api/permissions/:id`, `GET /api/agents?cwd=…`,
`GET /api/cwds`, and `GET /events` (server-sent events). Every endpoint needs the token
(cookie `fleet_token` or header `x-fleet-token`). See `src/shared/types.ts` for the shapes.

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

## Continue (resume)

`POST /api/sessions/:id/resume` continues an **ended** session — page-owned or
a terminal transcript picked up by the watcher — with a new prompt. The tree is
rebuilt from the existing transcript, the same session id is kept, and the
terminal session becomes page-owned (watched by the page from then on). Refused
with `409` while the session is still active (root running on the page, or the
transcript file modified within the last minute), `400` for bad input, `404`
for unknown ids.

## Run always-on (systemd user service + tailscale serve)

Create `dashboard/deploy/claude-fleet.service` (a simple user unit running
`npm start` in the dashboard directory), then:

```sh
ln -sf <repo>/dashboard/deploy/claude-fleet.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-fleet.service
```

Expose it to your tailnet only (never Funnel):

```sh
tailscale serve --bg --https=4317 http://127.0.0.1:4317
```

Undo with `tailscale serve --https=4317 off` and
`systemctl --user disable --now claude-fleet.service`.

## Security notes

- **Every API call is token-gated.** The token is generated on first start (dir mode `0700`,
  file mode `0600`) or taken from `FLEET_TOKEN`.
- `HOST=0.0.0.0` exposes the dashboard **to your whole network** (the default is
  `127.0.0.1`, local only), but each visitor still needs the token; POST/DELETE
  requests additionally get a same-origin check.
- The dashboard drives **your own Claude Code login** — starts, prompts and tool runs bill to
  your account, at real cost.
- Tool permissions normally asked by Claude Code in the terminal are **approved in the dashboard
  page** instead. Read the tool input before clicking Allow; denying replies through the SDK.
- Pages are plain `node:http` (no express), and the server never writes outside its `.data`
  directory.
