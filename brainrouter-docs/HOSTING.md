# Hosting BrainRouter (ADR-014 Phase G)

> **New here?** [`deploy/README.md`](../deploy/README.md) is the step-by-step dev
> setup + build-from-source deploy guide. This page is the hosting-topology
> reference (the three modes, the tunnel, the status endpoint). Everything is
> **built from source in this repo** — there is no published server image; the
> production stack (`deploy/stack`) compiles the image locally with
> `docker compose up -d --build`.

**One codebase, three deployments.** The `brain` process is a **single gateway**: one Express app
serves REST (`/api/*`), MCP (`/mcp`), the dashboard (`/dashboard`), `/health`, and the status
aggregation (`/api/status`) on one port (default `3747`). Everything a client needs is behind that one
URL. `BRAINROUTER_SERVICE` can split the planes across processes for scale, but the default — and the
target — is the unified gateway.

## The three modes

| Mode | How | Client points at |
|---|---|---|
| **Localhost self-host** | `docker compose -f deploy/stack/docker-compose.yml up` (or `npm start`) | `http://localhost:3747` |
| **Behind a Cloudflare tunnel** | add `deploy/tunnel/docker-compose.tunnel.yml` (a `cloudflared` sidecar) | `https://brain.example.com` |
| **Hosted multi-tenant** | run the stack on your infra behind your own LB/TLS | your public URL |

The **same build** serves all three — no code branch. Clients (CLI/desktop) resolve the brain via one
knob, `cli.brainUrl`, and **probe `/health` first**, falling back to an embedded brain when the remote
is down (already implemented in the CLI's `chatCommand`). External monitors can watch `/api/status`,
which returns `503` when any component is down.

## Cloudflare tunnel

`deploy/tunnel/` puts a Cloudflare tunnel in front of the single gateway — a stable public hostname
with **no inbound ports opened** (the tunnel dials out). Create a tunnel + token in Cloudflare Zero
Trust, route your hostname to `http://brain:3747`, set `TUNNEL_TOKEN` in `.env`, then:

```
docker compose -f deploy/stack/docker-compose.yml -f deploy/tunnel/docker-compose.tunnel.yml up -d
```

## Key configuration (DB/settings, not provider `.env`)

- **`BRAINROUTER_PORT`** — the single gateway port (default `3747`).
- **`BRAINROUTER_SERVICE`** — `brain` (unified, default) or `mcp` / `api` to split planes for scale.
- **`BRAINROUTER_SYSTEM_ORG_ID`** — which team's DB-resolved providers back the brain's *own* LLM calls
  (extraction, atlas, persona distillation). Defaults to the seeded admin's personal team. Documented
  in `deploy/stack/.env.example`.
- **SMTP** (verification/invitation/reset email) — configured in the DB via the dashboard
  (`/email-settings`) or `PUT /api/admin/email`, **never `.env`** (ADR-014 Phase B).
- **Providers** — DB-only (ADR-012); no provider secrets in `.env`.

## Status

`GET /api/status` aggregates the health of every component behind the gateway (gateway / REST / MCP /
database / memory), worst-of rollup, `503` on any outage. The public `/status` dashboard page renders it
(status-page style, auto-refresh). This is the single place to see whether the gateway and everything
behind it is healthy — in any of the three modes.
