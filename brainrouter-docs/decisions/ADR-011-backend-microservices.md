# ADR-011 — Backend decomposed into microservices (no longer a monolith)

> Status: **ACCEPTED — implemented (0.4.17).**
> Date: 2026-07-06. Realizes the extraction roadmap in ADR-006/008 and the ADR-010
> deploy topology. The brain stays reachable over **MCP**.

## Context

Through ADR-004/006/008 every backend capability was given a bounded module + a
typed `IService` port, but they still ran in **one process** — the brain served
MCP, REST, the trigger ingress, provider resolution, and the job runner all
together. ADR-010 shipped the multi-tenant features and a single extracted
service (the Provider Gateway). The remaining goal: run the backend as **separate
deployable services**, not a monolith.

Because the boundaries were already ports, this is a *deployment* split (new
entrypoints + a shared image + compose), not a rewrite. Each service reuses the
same code and the same Postgres; competing-consumer / stateless patterns keep it
safe.

## Decision

The backend is four services (plus Postgres), one Docker image, different
entrypoints:

| Service | Entry | Port | Role |
| --- | --- | :--: | --- |
| **brain** | `dist/index.js --http` | 3747 | MCP (`/mcp`) + REST (`/api/*`) + memory/cognition/Atlas. Runs with `BRAINROUTER_JOB_RUNNER=off` — it delegates async work. |
| **gateway** | `dist/services/gateway/index.js` | 3748 | Provider/LLM resolution (`POST /v1/resolve`), JWT-authed. (ADR-006 #1.) |
| **ingress** | `dist/services/ingress/index.js` | 3749 | Stateless GitHub webhook receiver: verify App HMAC → resolve tenant → enqueue. No JWT. |
| **worker** | `dist/services/worker/index.js` | — | Drains the shared `memory_jobs` queue (competing consumer; `--scale worker=N`). No HTTP. |

Design choices that make the split safe + light:
- **Shared code, thin entrypoints.** `gateway` + `ingress` run on their own
  `pg.Pool` and reuse the exact query + resolver code (`providerConfigQueries`,
  `integrationConfigQueries`, `jobQueries`, `providers/resolver`,
  `integrations/githubWebhook`) — no full `MemoryEngine`, so they're stateless
  and cheap. The brain owns schema/migrations.
- **One HMAC/webhook core** (`integrations/githubWebhook.ts`, unit-tested) runs
  in BOTH the in-brain route and the standalone `ingress` — one source of truth.
- **Competing consumers** for the queue: the `memory_jobs` claim is atomic, so N
  workers drain safely; the brain hands work off (`JOB_RUNNER=off`).
- **One trust root:** service-to-service auth reuses the brain's JWT
  (`BRAINROUTER_JWT_SECRET`); secrets are opened with the shared
  `BRAINROUTER_SECRET_KEY`.

## Consequences

- **Positive.** Independent scaling (spin up more `worker`s; front `ingress`
  behind one public URL; move `gateway` egress off the brain), independent
  failure domains, and a genuine microservice topology — while the brain remains
  a single MCP endpoint for the CLI/desktop/dashboard.
- **Cost.** More processes to run/observe; the shared image is larger than a
  purpose-built one (acceptable — one build, one artifact). Migrations run from
  the brain (or any engine-booting process) and are idempotent.
- **Compatibility.** Still runnable as a monolith: drop the extra services from
  compose and unset `JOB_RUNNER=off`, and the brain does everything in one
  process (local-first / single-node default).

## Not yet split (deliberately)

`retrieval/embeddings` (`IRetrievalService`) and the REST/auth API are still
in-brain; their ports exist, so they extract the same way (a thin entrypoint +
compose service) when a scale driver fires. `exec`/sandbox stays with whoever
runs jobs (the worker).
