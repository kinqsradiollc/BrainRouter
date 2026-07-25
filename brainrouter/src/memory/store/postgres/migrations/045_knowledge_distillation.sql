-- Project-scoped knowledge distillation provenance.
--
-- Derived notes remain ordinary knowledge documents so they use the existing
-- parse, chunk, embedding, retrieval, and authorization paths. Their origin is
-- explicit, and every source edge repeats the full tenant ancestry so neither
-- application bugs nor caller input can link documents across a Project.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'source',
  ADD COLUMN IF NOT EXISTS distillation_version integer;

ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_origin;
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_origin
    CHECK (origin IN ('source', 'derived'));

ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_distillation_version;
ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_distillation_version
    CHECK (
      (origin = 'source' AND distillation_version IS NULL)
      OR (origin = 'derived' AND distillation_version > 0)
    );

CREATE TABLE IF NOT EXISTS knowledge_document_provenance (
  derived_document_id text NOT NULL,
  source_document_id  text NOT NULL,
  base_id             text NOT NULL,
  org_id              text NOT NULL,
  project_id          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    derived_document_id,
    source_document_id,
    base_id,
    org_id,
    project_id
  ),
  FOREIGN KEY (derived_document_id, base_id, org_id, project_id)
    REFERENCES knowledge_documents(document_id, base_id, org_id, project_id)
    ON DELETE CASCADE,
  FOREIGN KEY (source_document_id, base_id, org_id, project_id)
    REFERENCES knowledge_documents(document_id, base_id, org_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT knowledge_document_provenance_no_self
    CHECK (derived_document_id <> source_document_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_document_provenance_source
  ON knowledge_document_provenance(
    org_id,
    project_id,
    base_id,
    source_document_id,
    derived_document_id
  );

-- Manual rollback (only before a newer migration depends on these objects):
--   DROP TABLE IF EXISTS knowledge_document_provenance;
--   ALTER TABLE knowledge_documents
--     DROP COLUMN IF EXISTS distillation_version,
--     DROP COLUMN IF EXISTS origin;
