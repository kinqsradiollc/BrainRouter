# ADR-013 — Split the MCP (memory) plane from the REST/auth plane

> Status: **ACCEPTED — implemented (0.4.17).**
> Date: 2026-07-06. Continues the ADR-011 decomposition. Brain stays on MCP.

## Context

After ADR-011 the backend already ran as separate services (gateway / ingress /
worker), but ONE process — the "brain" — still served BOTH the MCP tool plane
(the memory / agent brain) AND the entire REST/auth API (`/api/auth`, `/api/users`,
`/api/orgs`, `/api/admin/*`, `/api/memories`, `/v1/...`). Those two planes have
very different traffic shapes: MCP is agent tool-calls; REST/auth is dashboard +
web-chat + admin. Coupling them means you can't scale or isolate one without the
other.

## Decision

A single `BRAINROUTER_SERVICE` env selects the process role; the same image +
entrypoint (`dist/index.js`) serves a different plane per role:

| SERVICE | Serves | Role |
| --- | --- | --- |
| `brain` (default) | MCP **and** REST/auth | Single-node — unchanged, backward-compatible |
| `mcp` | MCP only (`/mcp` + `/health`) | The memory / agent brain |
| `api` | REST/auth only (`/api/*`, `/v1/*`, no `/mcp`) | Identity / tenancy / admin / memory-REST |

The gate is two booleans (`serveRest`, `serveMcp`) around the existing router and
MCP mounts — the default (`brain`) mounts both exactly as before, so existing
single-node deploys are byte-identical. The reference stack (`deploy/stack`) now
runs the decomposed topology: `brain` = `mcp`, plus a dedicated `api` service on
its own port.

Every mode still boots the shared engine (Postgres); the split is at the HTTP
surface, not the data layer. The brain remains reachable over MCP for the CLI /
desktop / agents.

## Consequences

- **Positive.** The auth/REST/dashboard tier scales and fails independently of
  the MCP brain; you can put the `api` tier behind its own autoscaler / WAF and
  keep the MCP brain lean. Point the dashboard's API URL at the `api` service and
  agents at the `mcp` service.
- **Compatibility.** `BRAINROUTER_SERVICE` unset ⇒ `brain` ⇒ both planes ⇒ no
  change for single-node. Collapse the stack back by setting the brain to
  `brain` and dropping the `api` service.
- **Cost.** Two more processes in the full topology; the shared image is reused
  (one build). Migrations + admin-seed run idempotently from any engine-booting
  process.

## The full backend topology (ADR-011 + 013)

`postgres` · `brain` (MCP) · `api` (auth/REST) · `gateway` (provider resolve) ·
`ingress` (GitHub webhooks) · `worker` (memory_jobs). Providers are DB-only
(ADR-012); the brain talks MCP.
