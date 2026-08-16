-- ADR-017 D3 — project_tag on source_documents.
--
-- cognitive_records already carry project_tag (002_schema); source_documents
-- only had workspace_tag (002) + org_id/project_id (019). Add project_tag so a
-- Project-scoped recall covers the raw source docs + chunks, not only the
-- distilled cognitive records. NULL-tolerant, like workspace_tag: legacy rows
-- and captures with no active Project marker keep a null tag and stay visible
-- in every scope.
ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS project_tag text;

CREATE INDEX IF NOT EXISTS idx_source_docs_project_tag
  ON source_documents(user_id, project_tag);
