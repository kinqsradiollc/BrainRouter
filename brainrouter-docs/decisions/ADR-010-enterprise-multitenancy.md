# ADR-010 — Enterprise multi-tenancy, DB-backed providers, RBAC & scoped memory

> Status: **ACCEPTED — in phased implementation (0.4.17+).**
> Date: 2026-07-06. Full plan: `brainrouter-docs/specs/enterprise-multitenancy-and-providers.md`.
> Builds on ADR-004 (modularization, incl. deferred Phase 5), ADR-005 (service-
> capable runtime), ADR-006/008 (service decomposition), ADR-007 (Postgres),
> ADR-009 (trigger ingress / GitHub App).

## Context

BrainRouter is scaling from a single-user local-first tool to production grade
across **single user / team / organization-enterprise**. Three things block that
today (confirmed by current-state maps):

- The backend configures its AI providers (LLM, embeddings, reranker, judge)
  purely from `.env`, read once at startup — no database, no per-tenant config,
  no admin UI. (This is ADR-004's intentionally **deferred Phase 5**.)
- Tenancy stops at `user_id`; there is no organization/team tier.
- Access control is a binary `is_admin`, with no role/capability model.

Meanwhile the backend is already service-capable (ADR-005 complete: remote
MCP/HTTP transport, JWT/API-key auth, Postgres-only, cloud image) and ~40
modules already expose typed `IService` ports (ADR-008). So the work is
**additive**, not a rewrite.

## Decision

1. **Organization becomes the top tenancy tier** above the existing user, with
   `owner/admin/member/viewer` **RBAC** capabilities. A single user is modeled as
   a one-person *personal org* (auto-created on signup), so local-first stays
   zero-config and existing `user_id` rows backfill cleanly.
2. **Providers become data, not `.env`.** LLM/embedding/reranker/judge configs
   live in a DB `provider_configs` table (org-scoped, admin-managed), mirroring
   the desktop/CLI `LLMConfig`/`ProviderDefinition` schema, with API keys
   **encrypted at rest**. A `ProviderResolver` replaces the `process.env` reads
   in `buildServices()`/`modelRunner`, with an env fallback during rollout —
   finally unblocking ADR-004 Phase 5.
3. **Only admins configure** providers + triggers, enforced by a
   `requirePermission(cap)` layer on both the HTTP API and the MCP config-tool
   path (which already carries caller identity).
4. **Memory gains org scoping** (`org_id` + `visibility ∈ {private, org}`) on top
   of the proven `user_id` chokepoint — org-shared / workspace / repo / private
   tiers, cross-org isolation as a hard WHERE.
5. **GitHub triggers run per-tenant** (ADR-009 extended): the org backend runs
   its own GitHub App *and* each local user runs their own; Phase 2 makes the
   ingress a hosted stateless service over a shared Postgres queue.
6. **The backend decomposes into microservices** by *activating* the
   already-ported boundaries (ADR-006/008), starting with the **Provider/LLM
   Gateway** (home of DB-backed providers). The brain stays reachable over MCP.

## Consequences

- **Positive.** One admin-managed place to configure providers per org (no `.env`
  edits, no secrets on disk); real team/enterprise isolation; least-privilege
  access; org-shared team memory; a webhook bot that scales to an org while local
  users keep their own — all on top of infra that already exists.
- **Cost / risk.** New tenancy tier touches every scoped query (mitigated: same
  chokepoint pattern as `user_id`, one clause + a test each); secret custody adds
  a KEK (`BRAINROUTER_SECRET_KEY`) + envelope encryption; per-tenant provider
  resolution replaces startup-cached singletons with a per-org registry.
- **Compatibility.** Local-first single-user never regresses; env-var providers
  keep working until a DB row supersedes them; migrations are additive +
  backfilled.

## Alternatives considered

- **Keep `.env`, add a UI that writes `.env`** — no multi-tenant story, secrets
  on disk, no per-org config. Rejected.
- **A separate config service from day one** — premature; the modules aren't all
  deployment-split yet and it complicates the local-first path. We extract the
  Provider Gateway first and split further only as scale drivers fire (ADR-008).
- **Row-Level Security in Postgres for isolation** — considered; deferred in
  favor of the proven application-level WHERE chokepoint (consistent with the
  existing `user_id` model), with RLS as a future hardening.
