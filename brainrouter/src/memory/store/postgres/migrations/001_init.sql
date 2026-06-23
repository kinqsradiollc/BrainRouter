-- ADR-007 Phase 1 — initial Postgres schema for the brain's memory store.
-- pgvector replaces sqlite-vec for embedding similarity. This is a representative
-- starting schema; the full per-type schema fills in with the PostgresMemoryStore
-- adapter (Phase 2), via further numbered migrations.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memory_records (
  id          text PRIMARY KEY,
  kind        text NOT NULL,
  session_key text,
  content     text NOT NULL,
  embedding   vector,                                   -- dim set per embedder; ANN index added when wired (Phase 5)
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_records_kind_idx ON memory_records (kind);
CREATE INDEX IF NOT EXISTS memory_records_session_idx ON memory_records (session_key);
