# ADR-007 — Postgres + pgvector memory store (behind `IMemoryStore`), SQLite stays the embedded default

**Status:** Accepted — implemented, then exceeded (verified 2026-08-16: PostgresMemoryStore + pgvector shipped; SQLite was subsequently REMOVED entirely, so the "SQLite stays the embedded default" and dual-backend-CI clauses no longer hold) · **Supersedes:** none · **Builds on:** [ADR-004](ADR-004-backend-modularization.md) (the `IMemoryStore` port), [ADR-005](ADR-005-service-capable-runtime.md) (service-capable), [ADR-006](ADR-006-service-decomposition-map.md) (DB as an external service)

> Add a **Postgres + pgvector** backend for the brain's memory, selected behind
> the existing `IMemoryStore` port by one config knob, so a brain can be
> **shared, persistent, and concurrent** instead of a single file per laptop.
> **SQLite stays the default** (embedded/offline; zero disruption). The Postgres
> instance is an **external, user-linked service** — not vendored into the repo;
> an optional local `docker-compose` (the official `pgvector` image, *pulled*)
> exists only for dev.

## Context

The brain's memory store today (survey 2026-06-23):

- **Engine:** `node:sqlite` (`DatabaseSync`, `allowExtension: true`),
  `SqliteMemoryStore implements IMemoryStore` (~5.4k LOC under
  `memory/store/`), constructed with a **file path** (`new
  SqliteMemoryStore("…/memory.db")`).
- **Vectors:** **`sqlite-vec` (^0.1.9)** — embeddings are stored and searched
  *inside* SQLite (there is **no separate vector DB**). Embeddings come from
  `EmbeddingService` (default `text-embedding-3-small`).
- **The port already exists:** ADR-004 made `IMemoryStore` the seam SQLite
  implements — so a second backend is an **adapter swap**, not a rewrite of
  callers.

### Why move

SQLite is excellent embedded, but it's **single-writer, file-bound, and
host-local**. The direction in ADR-005/006 — shared/hosted brains, multi-tenant,
the agent + multiple clients hitting one brain — needs a store that supports
**concurrent writers, network access, and central hosting**. That is Postgres.
The vector equivalent of `sqlite-vec` is **pgvector**, which keeps embeddings and
relational rows in **one transactional store** (no second system to operate).

## Decision

Introduce a **`PostgresMemoryStore implements IMemoryStore`** adapter using
**`pg`** (node-postgres) + **pgvector**, selected at runtime:

- **No `BRAINROUTER_DATABASE_URL` → SQLite** (today's default; nothing changes).
- **`BRAINROUTER_DATABASE_URL` set → Postgres + pgvector.**

Principles:

1. **Same port, swap the adapter.** Callers keep using `IMemoryStore`; the brain
   picks the concrete store from config. No route/tool/pipeline change.
2. **SQLite stays the embedded default** (matches ADR-005's "in-process-default").
   Postgres is opt-in for scale/hosted; CI exercises **both**.
3. **The DB is an external service (ADR-006), not vendored.** Users link their own
   Postgres 14+ with the `vector` extension; the repo ships only an *optional*
   local `docker-compose` that **pulls** `pgvector/pgvector` (no built/vendored
   image, default `postgres`/`postgres` creds for now).
4. **Parity-tested.** The existing `memory/store` test suite runs against **both**
   backends so Postgres behaviour matches SQLite before it's recommended.
5. **Vectors via pgvector**, not a separate vector DB — relational + vector in one
   connection, mirroring today's "vectors live with the data" model.

## Migration order (leaf-first, numbered phases)

- **Phase 0 — Infra + decision (this PR).** `deploy/postgres/` (compose + `CREATE
  EXTENSION vector` init + README), the `BRAINROUTER_DATABASE_URL` knob, and this
  ADR. **No behaviour change** — SQLite is still selected.
- **Phase 1 — Schema + connection.** Add `pg`; a pooled connection from
  `BRAINROUTER_DATABASE_URL`; a SQL schema mirroring the SQLite tables plus a
  `vector` column with an index (start `hnsw`/`ivfflat` — tuned in Phase 5); a
  tiny in-repo SQL migration runner.
- **Phase 2 — `PostgresMemoryStore` adapter.** Implement `IMemoryStore`
  method-by-method against `pg`; reuse the SQLite store's queries as the spec.
- **Phase 3 — Store selection + dual-CI.** The brain constructs Sqlite vs
  Postgres from config; the store test suite runs against both in CI.
- **Phase 4 — Data-migration tool.** Optional `sqlite → postgres` export/import so
  existing users carry their memory over.
- **Phase 5 — Vector parity + tuning.** Verify recall/reranker quality + latency
  on pgvector vs sqlite-vec; pick the index + params.

Each phase is one green PR (`npm run build && npm test` in `brainrouter/`),
behaviour-preserving, SQLite-default until Phase 3 proves parity.

## Alternatives considered

### Stay on SQLite (+ sqlite-vec) only
- **Rejected for scale:** single-writer + file-bound + host-local blocks shared/
  hosted/concurrent brains. Still the right *embedded* default, which is why it
  stays the default — this ADR *adds* a backend, it doesn't remove SQLite.

### A dedicated vector DB (Qdrant / Milvus / Weaviate / pgvector-as-separate)
- Pros: purpose-built vector scale.
- Cons: a *second* system to operate + a cross-store consistency problem; today
  vectors live transactionally with the data.
- **Rejected for now:** pgvector keeps one store. If vector load later outgrows
  pgvector, that's exactly the **retrieval service** (ADR-006 #3, driver D2) —
  split it out *then*, with evidence.

### Adopt an ORM (Prisma / Drizzle / Kysely)
- The store is hand-written SQL on `node:sqlite` today. A thin `pg` + raw SQL
  adapter preserves control and makes SQLite↔Postgres **parity** easiest to
  reason about. An ORM/query-builder can be revisited later; **deferred**, not
  rejected.

## Consequences

- A brain can be **shared, persistent, and concurrent** — unblocks the hosted/
  multi-tenant story in ADR-005/006 without changing any caller.
- **Two backends to maintain + test.** Mitigated by the shared port + the
  dual-backend parity suite (the gate that lets us trust Postgres).
- **pgvector index choice affects recall latency/quality** — owned explicitly in
  Phase 5 rather than guessed.
- **Zero disruption for local users:** no `BRAINROUTER_DATABASE_URL` → identical
  SQLite behaviour. Opt-in, reversible.

## What stays as-is

- The **`IMemoryStore` port** (the swap seam) and every caller above it.
- **`EmbeddingService`** — same provider-agnostic embeddings; only the vector
  *index* changes (sqlite-vec → pgvector).
- **SQLite** as the embedded/offline default and the test fixture for fast unit
  tests.
- The **server-env config model** (ADR-004 Phase 5): the deployable brain reads
  `BRAINROUTER_DATABASE_URL` from the environment, like its other server knobs.
