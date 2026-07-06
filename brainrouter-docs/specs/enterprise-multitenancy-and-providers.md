# Spec — Production-grade multi-tenancy, DB-backed providers, RBAC & memory scoping

> Status: **DRAFT → in implementation.** Date: 2026-07-06. Owner: backend + dashboard.
> Companion decision: `brainrouter-docs/decisions/ADR-010-enterprise-multitenancy.md`.
> Scale target: **single user → team → organization/enterprise**, backend as
> microservices, brain still spoken to over **MCP**.

## 1. Why / what changes

Three gaps block production multi-tenant scale (from the current-state maps):

1. **Providers live in `.env`.** The backend reads every LLM/embedding/reranker/
   judge credential from `process.env` **once** at startup in
   `brainrouter/src/memory/engine/lifecycleOps.ts` `buildServices()` (+
   `memory/llm/modelRunner.ts`). No DB, no per-tenant config, no admin UI. This
   is exactly ADR-004's **deferred Phase 5** (core↔backend LLM de-dup, gated on
   an env→`LLMConfig` adapter). The desktop/CLI already model providers as data
   (`LLMConfig` + `ProviderDefinition` + `cli.router`); the backend must adopt
   the **same schema**, sourced from the database, configured by admins.
2. **Tenancy is one tier too shallow.** Everything is `user_id`-scoped (every
   table, every query, `req.userId`, and the MCP path auto-injects
   `userId = defaultUserId` at `transport/mcpServer.ts:319`). There is **no
   organization/team**. `workspace_tag`/`project_tag` are optional *filter tags*
   within a user, not tenant boundaries.
3. **RBAC is binary.** Only `users.is_admin` + `requireAdmin` on `/api/users/*`.
   No `owner/admin/member/viewer`, no capability model.

The good news: the tenancy *pattern* is already correct, the backend is already
service-capable (ADR-005 done: remote MCP/HTTP, auth, Postgres, cloud image),
and ~40 modules already have typed `IService` ports (ADR-008). This is additive.

## 2. Tenancy model

Introduce **organization** as the top tenancy tier, above the existing `user`.

```
organization ──< membership (role) >── user
      │
      ├──< workspace >──< repo >         (org-owned scoping units)
      └──< provider_config / trigger_config / memory (org-shared) >
```

- **organizations**(`org_id` PK, `name`, `slug` UNIQUE, `plan`, `created_at`).
  `plan ∈ {single, team, enterprise}`.
- **org_members**(`org_id`, `user_id`, `role`, `created_at`), PK(`org_id`,`user_id`).
  `role ∈ {owner, admin, member, viewer}`. A user may belong to many orgs.
- **users** gains `default_org_id` (nullable) for the active-org default.
- **workspaces**/**repos** become **org-owned** rows (today `workspace_tag` is a
  path hash within a user; it becomes `workspace(org_id, tag, root, label)` and
  `repo(org_id, workspace_id, slug)`), so a team shares workspaces/repos.

**Single-user = a one-person org.** On first signup we auto-create a *personal
org* (`plan: single`) with the user as `owner`. Local desktop/CLI keep working
unchanged — they resolve to the caller's personal org with zero config. A
migration backfills every existing `user_id`-scoped row into that user's
personal org (`org_id` NOT NULL after backfill).

**Isolation.** `org_id` becomes a **hard WHERE** on every tenant-scoped query
(exactly like `user_id` today) — cross-org reads are impossible, not filtered.
Within an org, `user_id` + `visibility` decide private vs org-shared.

## 3. RBAC

Roles form a total order **owner > admin > member > viewer**, mapped to
capabilities (a static role→permission table, `can(role, cap)`):

| Capability | owner | admin | member | viewer |
|---|:--:|:--:|:--:|:--:|
| `org:manage` (rename, delete, plan, transfer) | ✓ | – | – | – |
| `members:manage` (invite, remove, set role) | ✓ | ✓ | – | – |
| `providers:manage` (LLM/embeddings/etc creds) | ✓ | ✓ | – | – |
| `triggers:manage` (GitHub App, webhooks, rules) | ✓ | ✓ | – | – |
| `memory:write` (own records) | ✓ | ✓ | ✓ | – |
| `memory:read` (own + org-shared) | ✓ | ✓ | ✓ | ✓ |
| `memory:share` (mark a record org-visible) | ✓ | ✓ | ✓ | – |

- **Enforcement, two layers:** HTTP middleware `requirePermission(cap)` (extends
  today's `requireAdmin`), and the MCP call path — config-mutating tools
  (provider/trigger writes) check the caller's role via the same context that
  already carries `defaultUserId`/`isAdmin` (now also `orgId`/`role`).
- **Single-user:** the sole `owner` holds every capability → zero friction; the
  local flow never sees a permission wall.
- **Back-compat:** `users.is_admin=true` maps to `admin` on the personal org
  during migration; `requireAdmin` becomes `requirePermission('members:manage')`.

## 4. DB-backed provider config (the headline — retires `.env`)

Providers become **data**, org-scoped, admin-managed, mirroring desktop/CLI.

**Schema** — `provider_configs`:

| column | notes |
|---|---|
| `id` PK, `org_id` FK | tenant scope |
| `kind` | `llm \| embedding \| reranker \| judge` (the 4 backend service roles) |
| `provider_id` | mirrors `ProviderDefinition.id` (`openai`, `anthropic`, …) |
| `label`, `base_url` | `base_url` = desktop `endpoint` |
| `api_key_ciphertext` | **encrypted at rest** (see below) — never plaintext |
| `model`, `models_json` | mirrors `LLMConfig.model` / `.models` |
| `wire_format` | mirrors `requestFormat` (`chat-completions`/`responses`/`anthropic-messages`/`gemini-generate`) |
| `reasoning_effort`, `extra_json` | per-provider knobs (mirrors `ProviderDefinition`) |
| `enabled`, `is_default` | `is_default` picks the active config per (org, kind) |
| `created_by`, timestamps | audit |

- **Secret custody.** API keys are encrypted with **AES-256-GCM envelope
  encryption**; the master key comes from `BRAINROUTER_SECRET_KEY` (a single
  infra secret / KMS-backed value — legitimate 12-factor infra, NOT a provider
  credential). A new `brainrouter/src/security/secretBox.ts` seals/opens values.
  Ciphertext is redacted from every API response + audit log; the dashboard sees
  only `hasKey: true`.
- **Resolver replaces `.env`.** A `ProviderResolver` reads
  `provider_configs` for `(orgId, kind)`, decrypts the key, and builds the
  service config — replacing the `process.env` reads in `buildServices()` and
  `modelRunner.ts`. During migration it **falls back to the env vars** when a
  row is absent, so nothing breaks mid-rollout (env becomes the seed, then is
  retired). This is ADR-004 Phase 5, finally unblocked.
- **Per-tenant services.** `buildServices()` caches creds once at startup today;
  it becomes a `ProviderRegistry` keyed by `(orgId, kind)` that lazily builds +
  caches per-org service instances (LLM runner, embedding, reranker, judge),
  invalidated on a provider write.
- **Admin API** — `/api/admin/providers` CRUD under `requirePermission('providers:manage')`,
  following the `api/routes/identity/users.ts` pattern.
- **Same UX as desktop.** The write path mirrors the desktop Models settings
  (fetch `/models`, pick, set default); the dashboard Providers page reuses that
  flow against the admin API.

## 5. Memory scoping (org / workspace / repo / user)

Extend today's `user_id` scoping with the org tier + a visibility flag:

- Add `org_id` (NOT NULL after backfill) + `visibility ∈ {private, org}` to the
  cognitive/graph/evidence tables. `workspace_tag`/`project_tag` stay as
  sub-scoping within an org (now backed by the `workspaces`/`repos` rows).
- **Recall** (`memory/recall/filters.ts` `applyFilters`) gains an org WHERE +
  visibility rule: a caller sees `org_id = caller.org AND (user_id = caller OR
  visibility = 'org')`, further narrowed by workspace/repo/session as today.
  Builds directly on the 0.4.15 `userId` pin — same chokepoint, one more clause.
- **Tiers:** *org-shared* (team knowledge), *workspace*, *repo*, *private-user*.
  `member` can read org-shared + own; `viewer` read-only; sharing a record
  (`private→org`) needs `memory:share`.

## 6. GitHub triggers — Phases 2 & 3 (extends ADR-009)

Your clarification, encoded: **both** the org backend and each local user run
their own GitHub App bot.

- **Per-tenant App config.** Phase 1's `cli.triggers.githubApp` (local) is joined
  by an org-scoped `integration_configs` row (`kind: github_app`) for the org
  backend App — admin-managed, key encrypted via §4's secretBox.
- **Phase 2 — hosted stateless ingress.** The webhook receiver
  (`triggers/server.ts`) runs in the backend (Express, already there), verifies
  `X-Hub-Signature-256`, resolves the **tenant** from the App installation →
  org, and enqueues into the **shared Postgres queue** (`memory_jobs` / fleet).
  It never executes. Runners (desktop/CLI/worker) poll their org's jobs. This is
  what makes ONE public webhook URL + ONE org App real, while local users keep
  their loopback receiver + personal App.
- **Phase 3 — tenancy/RBAC for triggers.** Trigger + App config gated by
  `triggers:manage`; job results routed to the originating org.

## 7. Microservice decomposition (brain stays MCP)

Do **not** rebuild — *activate* the already-ported boundaries (ADR-006/008) as
deployable services, in dependency order:

1. **Provider/LLM Gateway** (ADR-006 service #1) — the natural home for §4's
   DB-backed provider config + routing/fallback + the OpenAI-compat gateway that
   already exists in core. **Extract first** (it unblocks "no more `.env`").
2. **Trigger ingress** (§6 Phase 2) — stateless webhook service on the shared queue.
3. **Auth/Tenancy** — the identity + org/RBAC surface (may stay in the brain
   process initially; it's a module with a clean port).
4. **Retrieval/embeddings** + **Worker/jobs** — already have `IRetrievalService`
   / `IWorkerService` ports; promote to separate deployments only when scale
   drivers fire.

Deployment reuses the existing `/deploy/brain/Dockerfile` pattern + a compose/K8s
manifest per service; service-to-service auth uses the existing JWT/API-key
middleware. The brain remains reachable over MCP throughout.

## 8. Phased roadmap (each phase = a verified, committed slice)

| Phase | Deliverable | Depends on |
|---|---|---|
| **P0** | This spec + ADR-010 (design gate) | — |
| **P1** | Tenancy + RBAC schema (orgs, members, roles) + backfill migration + `can()` + tenant-context resolver (backend) | P0 |
| **P2** | `secretBox` + `provider_configs` table + `ProviderResolver` (DB→services, env fallback) + `buildServices()`/`modelRunner` sourced from DB | P1 |
| **P3** | `/api/admin/providers` CRUD + `requirePermission` middleware + MCP config-tool gating | P2 |
| **P4** | Dashboard: Providers admin page (desktop-parity UX) + Org/Members/Roles pages | P3 |
| **P5** | Memory org scoping: `org_id`+`visibility` migration + recall filter + isolation tests | P1 |
| **P6** | Trigger Phase 2 (hosted ingress + shared queue) + Phase 3 (per-tenant Apps, RBAC) | P1, P3 |
| **P7** | Provider/LLM-Gateway service extraction (+ deploy manifest) | P2 |

**Non-goals (this program):** billing/metering UI, SSO/SAML (leave hooks),
end-user self-serve org signup UX polish. The brain interface stays MCP.

## 9. Invariants / guardrails

- **Local-first never regresses.** Single-user = personal org, zero config; the
  desktop/CLI flow is unchanged. Env-var providers keep working until a DB row
  replaces them.
- **Secrets are encrypted at rest** and never returned by an API or logged. The
  only remaining env secret is the infra `BRAINROUTER_SECRET_KEY` (KEK) + DB URL
  + JWT secret.
- **Cross-org isolation is a hard WHERE**, mirrored from the proven `user_id`
  chokepoint; every new tenant-scoped query gets the `org_id` clause + a test.
- **Additive migrations**, backfilled, reversible where possible; Postgres is
  already mandatory (ADR-007).
