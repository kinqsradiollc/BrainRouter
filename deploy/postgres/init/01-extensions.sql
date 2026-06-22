-- Runs once on first container start (docker-entrypoint-initdb.d).
-- pgvector replaces the current sqlite-vec vector search; the brain's
-- PostgresMemoryStore relies on it for embedding similarity queries.
CREATE EXTENSION IF NOT EXISTS vector;
