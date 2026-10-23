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
| `HOST`       | `0.0.0.0`   | Bind address                                       |
| `FLEET_TOKEN`| generated   | Shared token; stored in `.data/token` otherwise    |

## API

`GET /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions`,
`POST /api/sessions/:id/message`, `POST /api/sessions/:id/interrupt`,
`DELETE /api/sessions/:id`, `POST /api/permissions/:id`, `GET /api/agents?cwd=…`,
`GET /api/cwds`, and `GET /events` (server-sent events). Every endpoint needs the token
(cookie `fleet_token` or header `x-fleet-token`). See `src/shared/types.ts` for the shapes.

## Security notes

- **Every API call is token-gated.** The token is generated on first start (dir mode `0700`,
  file mode `0600`) or taken from `FLEET_TOKEN`.
- `HOST=0.0.0.0` (the default) exposes the dashboard **to your whole network**, but each
  visitor still needs the token; POST/DELETE requests additionally get a same-origin check.
- The dashboard drives **your own Claude Code login** — starts, prompts and tool runs bill to
  your account, at real cost.
- Tool permissions normally asked by Claude Code in the terminal are **approved in the dashboard
  page** instead. Read the tool input before clicking Allow; denying replies through the SDK.
- Pages are plain `node:http` (no express), and the server never writes outside its `.data`
  directory.
