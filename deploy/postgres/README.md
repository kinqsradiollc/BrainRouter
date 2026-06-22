# BrainRouter — Postgres (scale-mode memory store)

The brain's memory store can run on **SQLite** (default, embedded, per-laptop) or
**Postgres + pgvector** (scale mode: one shared, persistent brain). This folder is
an **optional** local Postgres for development — you can ignore it and point at any
Postgres you already have.

## Option A — your own Postgres (recommended for real deployments)

Any **Postgres 14+** with the **`vector`** extension works (managed RDS, Neon,
Supabase, your own cluster). Enable the extension once:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then point the brain at it:

```bash
export BRAINROUTER_DATABASE_URL="postgres://USER:PASSWORD@HOST:5432/DBNAME"
```

The Postgres image/instance is **not** part of this repo — you link your own.

## Option B — quick local container (pulls the official pgvector image)

```bash
cd deploy/postgres
docker compose up -d        # pulls pgvector/pgvector:pg16, creates the volume
# brain connection string:
#   postgres://postgres:postgres@localhost:5432/brainrouter
```

Defaults (override with env / a local `.env` next to the compose file):

| Var | Default | Notes |
|-----|---------|-------|
| `POSTGRES_USER` | `postgres` | |
| `POSTGRES_PASSWORD` | `postgres` | **default for now while scaling** — set a real secret before any shared/hosted deploy |
| `POSTGRES_DB` | `brainrouter` | |
| `POSTGRES_PORT` | `5432` | host port |

`init/01-extensions.sql` enables `vector` on first start. Data persists in the
`brainrouter-pg` Docker volume. Tear down with `docker compose down` (keep data)
or `docker compose down -v` (wipe).

## How the brain chooses a store

- No `BRAINROUTER_DATABASE_URL` → **SQLite** (today's default; nothing changes).
- `BRAINROUTER_DATABASE_URL` set → **Postgres + pgvector** via the
  `PostgresMemoryStore` adapter (same `IMemoryStore` port as SQLite).

See [ADR-007](../../brainrouter-docs/decisions/ADR-007-postgres-memory-store.md) for
the migration plan and rationale.
