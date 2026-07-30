-- Source documents participate in the same organization/project/workspace
-- hierarchy as cognitive records. Existing rows inherit their owner's default
-- organization; project/workspace remain nullable for legacy/local captures.

ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE source_documents ADD COLUMN IF NOT EXISTS project_id text;

UPDATE source_documents d
SET org_id = u.default_org_id
FROM users u
WHERE d.user_id = u.user_id
  AND d.org_id IS NULL
  AND u.default_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_source_docs_scope
  ON source_documents(user_id, org_id, project_id, workspace_tag, created_at);

CREATE INDEX IF NOT EXISTS idx_source_docs_scope_hash
  ON source_documents(user_id, org_id, project_id, workspace_tag, hash);
