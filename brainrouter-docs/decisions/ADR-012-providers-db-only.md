# ADR-012 — Providers are DB-only (the `.env` routing cutover is finished)

> Status: **ACCEPTED — implemented (0.4.17).**
> Date: 2026-07-06. Completes the ADR-010 P2 "retire `.env`" work.

## Context

ADR-010 P2 added DB-backed provider configs + a resolver, but left `.env` as a
runtime FALLBACK: `resolveProviderConfig` fell back to `resolveFromEnv`,
`buildServices()` still constructed the embedding/reranker/judge services from
`BRAINROUTER_*` env, `modelRunner` read `BRAINROUTER_LLM_*` credentials, and the
`/v1/chat/completions` proxy read `BRAINROUTER_LLM_ENDPOINT/API_KEY/MODEL`. So
operators still *saw* — and had to set — provider credentials in `.env`, which is
inconsistent with desktop/CLI (where providers live in config) and with the
multi-tenant model (providers are per-org in the DB).

## Decision

Providers (LLM / embeddings / reranker / judge) are configured **only in the DB**,
per org, by an admin (dashboard → AI Providers, or `POST /api/admin/providers`) —
never `.env`. Concretely:

- `resolveProviderConfig(store, orgId, kind)` is **DB-only** — no env fallback.
- `buildServices()` builds the embedding/reranker/judge services **unconfigured**
  (no env credentials); `applyProviderOverrides()` configures them from the DB.
  `modelRunner` takes its endpoint/apiKey/model (and optional fallback) **only**
  from the DB-resolved `providerOverride`. Only OPERATIONAL knobs (timeouts,
  concurrency, breaker, `EMBEDDING_DIMENSIONS` schema width, judge opt-in) remain
  env-driven — those are not credentials.
- The memory-augmented `/v1/chat/completions` proxy resolves its upstream from the
  DB (caller's org → system org), not env.
- **Migration is non-breaking:** on boot, `seedProvidersFromEnv` migrates any
  legacy `BRAINROUTER_*` provider vars into the system org's DB config **once**
  (idempotent; never overwrites a dashboard-set provider), logs a line, and then
  the vars are dead. Templates (`brainrouter/.env.example`,
  `deploy/stack/.env.example`, the stack compose) drop the provider credential
  vars entirely.

## Consequences

- **Positive.** One way to configure providers everywhere (desktop/CLI/backend);
  per-org providers for multi-tenant; secrets encrypted at rest (KEK) instead of
  plaintext env; a config change in the dashboard takes effect without editing
  env + restarting a fleet.
- **Bootstrap.** A fresh install has NO provider until an admin adds one — the
  services report "not configured" (recall degrades to keyword-only, cognition is
  skipped) rather than crashing. An upgrading install auto-seeds from its old env
  on first boot, so nothing breaks.
- **Unchanged.** The operational tuning knobs (timeouts/concurrency/breaker/
  dimensions) stay in env — they are not credentials and are deployment-level.

## Tests

`model-runner.test.ts` drives the runner via `setProviderOverride` (its new
credential source). `providers/seed.test.ts` covers DB-only resolution (env is
not a fallback), the one-time env→DB migration, idempotency, and the empty case.
Full backend suite green (802 tests).
