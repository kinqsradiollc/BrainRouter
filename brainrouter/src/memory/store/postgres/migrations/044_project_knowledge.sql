-- 044_project_knowledge — project-scoped source knowledge foundation.
--
-- This migration is deliberately additive and exposes no API by itself. Every
-- row repeats org/project ancestry and proves it through composite foreign keys,
-- so a store/query bug cannot attach a base, document, chunk, or embedding to a
-- foreign tenant. Knowledge vectors live in their own undimensioned pgvector
-- table; exact retrieval must filter by model + dimensions and is unaffected by
-- cognitive_vec dimension rebuilds.

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_id_org
  ON projects(project_id, org_id);

CREATE TABLE IF NOT EXISTS knowledge_bases (
  base_id      text PRIMARY KEY,
  org_id       text NOT NULL,
  project_id   text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (base_id, org_id, project_id),
  FOREIGN KEY (project_id, org_id)
    REFERENCES projects(project_id, org_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_bases_name_bounds
    CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  CONSTRAINT knowledge_bases_description_bounds
    CHECK (char_length(description) <= 4000)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_bases_project_name
  ON knowledge_bases(org_id, project_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_project_updated
  ON knowledge_bases(org_id, project_id, updated_at DESC, base_id);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  document_id    text PRIMARY KEY,
  base_id        text NOT NULL,
  org_id         text NOT NULL,
  project_id     text NOT NULL,
  title          text NOT NULL,
  source_name    text NOT NULL DEFAULT '',
  source_format  text NOT NULL,
  content_text   text NOT NULL,
  content_sha256 text NOT NULL,
  status         text NOT NULL DEFAULT 'queued',
  status_message text,
  parse_version  integer NOT NULL DEFAULT 1,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  ready_at       timestamptz,
  UNIQUE (document_id, base_id, org_id, project_id),
  FOREIGN KEY (base_id, org_id, project_id)
    REFERENCES knowledge_bases(base_id, org_id, project_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_documents_title_bounds
    CHECK (btrim(title) <> '' AND char_length(title) <= 500),
  CONSTRAINT knowledge_documents_source_name_bounds
    CHECK (char_length(source_name) <= 500),
  CONSTRAINT knowledge_documents_source_format_bounds
    CHECK (btrim(source_format) <> '' AND char_length(source_format) <= 64),
  CONSTRAINT knowledge_documents_sha256
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT knowledge_documents_status
    CHECK (status IN ('queued', 'parsing', 'ready', 'failed')),
  CONSTRAINT knowledge_documents_status_message_bounds
    CHECK (status_message IS NULL OR char_length(status_message) <= 2000),
  CONSTRAINT knowledge_documents_parse_version
    CHECK (parse_version > 0)
);

-- Dedupe is intentionally per base: the same source may be useful in two
-- independently managed bases, but one base never queues identical persisted
-- (already normalized/redacted) content twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_knowledge_documents_base_content
  ON knowledge_documents(org_id, project_id, base_id, content_sha256);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_base_status
  ON knowledge_documents(org_id, project_id, base_id, status, updated_at DESC, document_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_documents_pending
  ON knowledge_documents(org_id, project_id, updated_at, document_id)
  WHERE status IN ('queued', 'parsing');

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id       text PRIMARY KEY,
  document_id    text NOT NULL,
  base_id        text NOT NULL,
  org_id         text NOT NULL,
  project_id     text NOT NULL,
  ordinal        integer NOT NULL,
  content        text NOT NULL,
  content_sha256 text NOT NULL,
  token_count    integer,
  char_start     integer,
  char_end       integer,
  locator_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  content_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  UNIQUE (chunk_id, document_id, base_id, org_id, project_id),
  UNIQUE (document_id, ordinal),
  FOREIGN KEY (document_id, base_id, org_id, project_id)
    REFERENCES knowledge_documents(document_id, base_id, org_id, project_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_chunks_ordinal CHECK (ordinal >= 0),
  CONSTRAINT knowledge_chunks_content CHECK (content <> ''),
  CONSTRAINT knowledge_chunks_sha256
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT knowledge_chunks_token_count
    CHECK (token_count IS NULL OR token_count >= 0),
  CONSTRAINT knowledge_chunks_offsets
    CHECK (
      (char_start IS NULL AND char_end IS NULL)
      OR (char_start IS NOT NULL AND char_end IS NOT NULL AND char_start >= 0 AND char_end >= char_start)
    ),
  CONSTRAINT knowledge_chunks_locator_object
    CHECK (jsonb_typeof(locator_json) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON knowledge_chunks(org_id, project_id, base_id, document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_content_fts
  ON knowledge_chunks USING GIN(content_tsv);

CREATE TABLE IF NOT EXISTS knowledge_chunk_embeddings (
  chunk_id        text NOT NULL,
  document_id     text NOT NULL,
  base_id         text NOT NULL,
  org_id          text NOT NULL,
  project_id      text NOT NULL,
  embedding_model text NOT NULL,
  dimensions      integer NOT NULL,
  embedding       vector NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, embedding_model),
  FOREIGN KEY (chunk_id, document_id, base_id, org_id, project_id)
    REFERENCES knowledge_chunks(chunk_id, document_id, base_id, org_id, project_id) ON DELETE CASCADE,
  CONSTRAINT knowledge_chunk_embeddings_model
    CHECK (btrim(embedding_model) <> '' AND char_length(embedding_model) <= 256),
  CONSTRAINT knowledge_chunk_embeddings_dimensions
    CHECK (dimensions BETWEEN 1 AND 16000 AND vector_dims(embedding) = dimensions)
);

-- Exact cosine retrieval filters this scope before ordering by distance. An ANN
-- index is intentionally absent because this table may contain multiple models
-- and dimensions; a later production-scale migration can add per-model partial
-- indexes without coupling this domain to cognitive_vec.
CREATE INDEX IF NOT EXISTS idx_knowledge_embeddings_scope
  ON knowledge_chunk_embeddings(org_id, project_id, base_id, embedding_model, dimensions);

-- Manual rollback (only before a newer migration depends on these objects):
--   DROP TABLE IF EXISTS knowledge_chunk_embeddings;
--   DROP TABLE IF EXISTS knowledge_chunks;
--   DROP TABLE IF EXISTS knowledge_documents;
--   DROP TABLE IF EXISTS knowledge_bases;
--   DROP INDEX IF EXISTS uq_projects_id_org;
-- The migration runner is forward-only, so restore the preceding application
-- image first and execute the statements explicitly.
