# ADR-016 — Server-Side Connectors + Desktop as a Backend Client

**Status:** Accepted — implemented (verified 2026-08-16: C0–C5 all shipped — per-user sealed `connector_configs` store, server OAuth broker with GitHub device flow, `connector_sync` job executor, org-scoped connector routes, desktop repointed off local connector files) · **Supersedes** ADR-015 §D1 (per-plan best-fit auth) with a
single unified model · **Extends** ADR-010 (tenancy), ADR-009 (GitHub App). **No commits** until the
program is agreed and each phase is verified.

## Context — grounded audit (three parallel investigations)

Today the desktop is **local-first**: the agent runs in-process, and connectors live entirely
desktop-local. The decision (this ADR) is to make **connectors server-hosted and sign-in-gated**, and
the **desktop a full backend client** (orgs/teams, shared memory, projects, connectors — a peer of the
dashboard). The audit found this is far more "swap persistence + credentials" than "rewrite":

### What already exists (reuse)
- **Connector runtime is ~90% portable core.** `packages/core/src/connectors/` holds the 12 source
  runtimes, the checkpoint orchestration (`runtime/runCheckpoint.ts`, DI'd via `buildCheckpointRunner`),
  retrieval, and the `ConnectorDocument → memory` bridge (`retrieval/memoryBridge.ts`
  `exportConnectorDocumentsForMemory`). The `ConnectorRecord` (`packages/types/src/connector.ts:127`)
  stores only a **credential *reference*, never the secret**. A server path already exists:
  `brainrouter/src/tools/atlas/connectors.ts` (`connector_list`/`connector_run`) — but env-token only
  and `userId='default'` (`:103`).
- **Backend job runner + per-user fan-out.** Durable `memory_jobs` queue (`migrations/002_schema.sql:98`),
  `MemoryJobRunner` tick loop (`memory/scheduler/runner.ts:132`), dedicated `services/worker/`, and a
  **per-user scheduling precedent**: `enqueueScheduledMaintenance` iterates `listUsers()` → enqueues a
  job per user (`memory/engine/maintenanceOps.ts:31-85`). `run_after` gives delayed/periodic execution.
- **User/org/visibility-scoped memory + ingest.** `ingestSource()` (`memory/source/ingest.ts:23`),
  `source_documents`/`cognitive_records` scoped by `user_id`/`workspace_tag`/`org_id`/`visibility`
  (`002_schema.sql:119`, `008_memory_org_scope.sql:10`). The repo-ingest path (`ingestRepo.ts`) is the
  template a server connector-run follows.
- **Sealing + DB-secret precedent.** `secretBox` AES-256-GCM `seal`/`open` (`security/secretBox.ts:85`);
  `provider_configs`/`integration_configs` are the org-scoped sealed-secret pattern to mirror.
- **Auth + hosted MCP plane.** `POST /api/auth/signin → {jwt, refreshToken, apiKey}`
  (`api/routes/identity/auth.ts:51`), personal-org-on-signup (`:113`), `X-BrainRouter-Org` org context
  (`api/middleware/tenancy.ts:20`). The **MCP pool already supports an `http` brain with per-user Bearer
  auth** (`packages/core/src/mcp/client/transport.ts:165`; `brainrouter/src/index.ts:283-308`, IDOR-pinned).
  The SDK `BrainRouterClient` has `signIn()`/`refresh()` (`packages/sdk/src/client.ts:61-150`).

### The exact gaps (build)
| Gap | Where |
|---|---|
| Per-user connector config + credential **DB store** (today: `connectors.json` keyed by local path, `process.env` creds) | `packages/core/src/connectors/store/connectorStore.ts:28`; no `user_id` anywhere |
| **OAuth broker** (start/callback/PKCE/exchange/refresh + per-user token store) | none exists; `ConnectorCredentialMode` has `"oauth"` but nothing backs it |
| **`connector_sync` job executor** + enqueue policy | registry `memory/scheduler/executors.ts:68` |
| Desktop **→ backend HTTP client / sign-in / JWT storage** | desktop only fetches providers + GitHub |
| SDK **`X-BrainRouter-Org`** header support | `sdk/src/client.ts:85` (Authorization only) |
| MCP `memory_recall` **org-shared plumbing** (`filters.orgId` never set) | `tools/recall/memory_recall.ts:64,72` |
| Backend **connector REST/tool routes** (org-scoped) | no `/connectors` in `index.ts` |

## Decisions

- **D1 — Connectors are server-hosted, per-user, sign-in-gated.** Connecting any source requires a
  BrainRouter sign-in; connector config + credentials live in the backend (sealed), not desktop files.
- **D2 — Desktop becomes a full backend client.** Sign-in unlocks orgs/teams, org-shared memory,
  projects, and connectors, all via the backend — real desktop↔dashboard parity.
- **D3 — The agent stays local.** The turn loop, workspace files, code-editing, terminals, `git`/`gh`,
  and provider LLM calls remain in the Electron host (that's the point of the desktop). Only **memory,
  connectors, orgs/projects** become backend-backed.
- **D4 — Reuse the core connector runtime unchanged.** Inject a **DB-credential resolver** into
  `CheckpointRunnerDeps` in place of `defaultEnvTokenResolver`; the per-source switch needs zero edits.
- **D5 — One server OAuth broker.** `/api/connectors/:source/oauth/{start,callback}`, JWT-guarded, PKCE
  `state`, code→token exchange. Per-provider OAuth-**app** `client_secret` sealed in an **org-scoped**
  config; per-**user** access/refresh tokens sealed in the new per-user store. `http://localhost`
  callbacks make a self-hosted backend the callback target — no tunnel.
- **D6 — Syncs run in the job runner.** A `connector_sync` executor, enqueued per-user-per-due-connector
  following the `enqueueScheduledMaintenance` pattern; token refresh via a sibling executor.
- **D7 — Offline is preserved for the agent, not for connectors.** Signed-out, the desktop still runs
  the local agent + files + a local `stdio` brain (today's offline behavior). Connectors and org-shared
  memory simply require sign-in (the D1 decision). No hard launch gate that bricks offline use.

## Architecture

```
 DESKTOP (Electron, stays local)                    BACKEND (brainrouter)
 ┌───────────────────────────────┐                  ┌─────────────────────────────────────────┐
 │ agent loop · files · git · gh │                  │ /api/auth/signin → JWT + apiKey (exists) │
 │ provider LLM calls (local)    │◄── sign in ──────│ /api/orgs, projects, /api/memories (exist)│
 │ MCP pool ── http brain ───────┼──Bearer+X-Org───►│ MCP plane (per-user, IDOR-pinned) (exists)│
 │ "Connect X" → system browser  │                  │ OAuth broker /connectors/:s/oauth/* (NEW) │
 └───────────────────────────────┘                  │ connector_configs (user/org, sealed) (NEW)│
        memory · orgs · connectors                   │ connector_sync job → core runtime → memory│
        now backend-backed                           │   (reuses buildCheckpointRunner) (NEW glue)│
                                                      └─────────────────────────────────────────┘
```

## Phased plan (cheapest-first; each verified locally; no commits until approved)

| Phase | Scope | Anchors | Verify |
|---|---|---|---|
| **C0 — Sign-in + hosted memory** *(mostly config)* | Host backend client (reuse SDK `BrainRouterClient`), login UI, JWT/refresh in main-process `secretStore`; on sign-in write the returned `apiKey` into an `http` brain profile → reconnect pool → **memory is instantly backend-backed** | `sdk/src/client.ts:61`; `host/queries.ts:3033`; `configTypes.ts:759` (`cli.brainUrl`) | sign in → recall/capture hit the hosted brain |
| **C1 — Agent sees org-shared memory** | Thread org into the MCP plane (`X-BrainRouter-Org` → `buildMcpServer` → `memory_recall` sets `filters.orgId`); add SDK org-header + desktop org-picker | `index.ts:308`; `tools/recall/memory_recall.ts:64`; `sdk/client.ts:85` | signed-in agent recalls `visibility='org'` records |
| **C2 — Per-user store + OAuth broker** | `connector_configs` table (user/org/visibility, `config_json`, `credential_ciphertext`, `checkpoint_json`) + DB `ConnectorStore`; broker routes (PKCE, exchange); client_secret sealed org-scoped | mirror `009_integration_configs.sql`; `secretBox.ts:85` | unit: seal/open, broker; live GitHub OAuth via server |
| **C3 — Server-side sync runner** | `connector_sync` executor runs `buildCheckpointRunner` with a DB-credential resolver → ingest scoped by user/org/visibility; enqueue per-user-per-due; `connector_token_refresh` | `executors.ts:68`; `maintenanceOps.ts:46`; `runCheckpoint.ts:76` | a server connector runs on schedule → user memory |
| **C4 — Connector routes + desktop repoint** | Org-scoped connector REST/tool surface (RBAC `connectors:manage`); repoint desktop's ~40 connector handlers file→REST; "Connect X" → broker in system browser | `host/queries.ts:469-656` | desktop connector round-trips backend |
| **C5 — Migration + deprecate local modes** | First-sign-in: read local `connectors.json`, POST definitions to backend under chosen org, keep local as fallback; creds re-entered (never shipped); retire `gh`/PAT/device-flow connector modes | `host/queries.ts:534` (export/import bundles) | local connectors migrate; server-only enforced |

**C0 alone** delivers backend-backed memory with almost no new server code — highest leverage first.
The two heavy slices are **C3** (server connector runner) and **C4** (connector routes + UI repoint).

## Migration & offline
- Users with local connectors: on first sign-in, migrate definitions to the backend (bundles already
  exist); **credentials are re-entered / re-authorized via the broker, never shipped** (matches the
  "secrets in backend custody, never on the desktop" posture).
- Server-only applies to **connectors + org-shared memory**. The **local agent + files + a local
  `stdio` brain still work signed-out** (D7) — offline users lose connectors, not the app.

## Security
- Two distinct secrets, two scopes: OAuth-**app** `client_secret` (org/operator, sealed org-scoped) vs
  per-**user** access/refresh tokens (sealed per-user). Both via `secretBox`. No `.env` secrets.
- Broker `state` is a signed, short-TTL, PKCE-bound value tied to the initiating `userId`.
- Per-user MCP/REST calls stay IDOR-pinned (`transport/mcpServer.ts:307`); org isolation via existing
  `visibility`/`org_id` filters.

## Non-goals
- Moving the agent runtime or workspace file I/O server-side (stays local, D3).
- Cron-expression scheduling (tick-counter cadence like maintenance is sufficient).
- Implementing the 16 catalog-only sources' runtimes (out of scope; only the 12 live sources move).
