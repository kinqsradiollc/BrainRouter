# BrainRouter production stack (ADR-010)

One-command Postgres + service-capable brain for single-user, team, or
organization/enterprise deployments. The brain is reachable over **MCP** (the
CLI, desktop, and dashboard connect to it); everything is multi-tenant + RBAC'd.

## Run

```bash
cd deploy/stack
cp .env.example .env          # then fill the required secrets (below)
docker compose up -d --build
# brain → http://localhost:3747   (MCP /mcp · REST /api/* · /health)
```

### Required secrets (in `.env`)

| Var | What |
| --- | --- |
| `POSTGRES_PASSWORD` | Postgres password. |
| `BRAINROUTER_JWT_SECRET` | JWT signing key (sessions reset on boot without it). |
| `BRAINROUTER_SECRET_KEY` | **AES-256-GCM KEK** (base64/hex 32 bytes) that encrypts provider + integration API keys at rest. Generate: `openssl rand -base64 32`. Without it, admins can configure everything except secrets. |
| `BRAINROUTER_ADMIN_PASSWORD` | Seeds the first admin (its API key prints once in the logs — clear this after first boot). |

**Providers are configured in the database, not `.env`.** After first boot, sign
in to the dashboard as the admin → **AI Providers**, or `POST /api/admin/providers`
(both gated by the `providers:manage` capability), to add the LLM / embeddings /
reranker providers. The embedding **vector width** is derived from the embedder
automatically — nothing to set. Legacy `BRAINROUTER_*_LLM/EMBEDDING/...` env vars,
if still present, are migrated into the DB once on first boot, then ignored.

### Bundled services

| Service | Role |
| --- | --- |
| `postgres` | Postgres 16 + pgvector — the memory store (the only stateful service). |
| `redis` | **Optional** read cache (CVE catalog, hot GETs). Disposable — the brain falls back to an in-process cache if it's removed. Wired via `BRAINROUTER_REDIS_URL`. |
| `migrator` | One-shot: applies all pending DB migrations before any service serves. |
| `brain` | MCP plane (`/mcp`). Single-node mode (`BRAINROUTER_SERVICE=brain`) also serves REST + `/v1`. |
| `api` | Auth + REST API plane (identity/tenancy/admin/memory REST). |
| `gateway` | OpenAI-compatible model gateway (`/v1`) over the org's managed models. |
| `worker` | Durable-job runner (scans, vulnerability sync, meetings summarization). |
| `stt` | First-party Whisper speech-to-text for Meetings (internal-only). |
| `remote-relay` | Outbound-WSS broker edge for enrolled devices (never decrypts). |

Every image runs **unprivileged** (the `node` user). To collapse the decomposed
services back to a single node, run only `postgres` + `redis` + `migrator` +
`brain` with `BRAINROUTER_SERVICE=brain`.

### Single user vs. team vs. organization

- **Single user** — the seeded admin gets a personal org automatically; nothing
  else to do. Local-first desktop/CLI keep working unchanged.
- **Team / organization** — create members (`/api/users`), add them to an org
  with a role (`owner/admin/member/viewer`) in the dashboard → **Organizations**.
  Only `owner/admin` may configure providers, triggers, and members.

## Microservice decomposition — where it stands + how to split further

The brain runs today as **one service-capable process** (memory · cognition ·
Atlas · tenancy/RBAC · DB providers · trigger ingress · fleet). This is the
correct default: every capability already sits behind a typed `IService` port
(ADR-004/006/008), so splitting one into its own process is a deployment change,
not a rewrite. Per **ADR-008**, a module is promoted to a separate *process* only
when a scale driver fires (D1 security · D2 scale · D3 shared-state · D4 async ·
D5 policy) — not preemptively.

Extraction order when the drivers do fire (ADR-006):

1. **Provider / LLM Gateway** (D5, D3, D2) — the natural first split. The logic
   already exists (`brainrouter/src/providers/*` + `resolver.ts`): stand it up as
   its own service exposing `resolveProviderConfig` over HTTP, so every service's
   model calls egress through one authenticated, rate-limited, cost-metered hop.
2. **Trigger ingress** — the stateless webhook receiver
   (`brainrouter/src/triggers/server.ts`) resolves the tenant from the GitHub App
   installation (`memoryEngine.integrations.getResolvedIntegration`) and enqueues
   into the shared Postgres queue; runners poll per-tenant. (ADR-010 P6b.)
3. **Retrieval / embeddings** (`IRetrievalService`) and **Worker / jobs**
   (`IWorkerService`) — already ported; give each its own deployment + `depends_on`
   this Postgres when the hot path needs to scale independently.

Each new service reuses this stack's Postgres + the existing JWT/API-key auth
middleware for service-to-service calls, and the brain stays reachable over MCP
throughout. See `brainrouter-docs/decisions/ADR-006/008` for the full map.
