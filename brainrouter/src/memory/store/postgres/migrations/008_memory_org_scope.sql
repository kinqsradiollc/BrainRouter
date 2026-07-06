-- 008_memory_org_scope.sql — ADR-010 P5: org scoping + visibility on memory.
--
-- Adds the org tier to the primary memory table on top of the proven user_id
-- scope: `org_id` (which organization the record belongs to) and `visibility`
-- (private = only the owning user; org = shared with the whole organization).
-- Backfills org_id from each user's default (personal) org, so existing memory
-- is org-tagged with no behaviour change (recall is still user-scoped; this is
-- the data + isolation foundation, the org-shared retrieval union is P5b).

ALTER TABLE cognitive_records ADD COLUMN IF NOT EXISTS org_id text;
ALTER TABLE cognitive_records ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';

-- Backfill: a record belongs to its owner's default (personal) org.
UPDATE cognitive_records c
SET org_id = u.default_org_id
FROM users u
WHERE c.user_id = u.user_id AND c.org_id IS NULL AND u.default_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cognitive_org ON cognitive_records(org_id, user_id);
-- Fast lookup of org-shared records (the P5b retrieval union filters on this).
CREATE INDEX IF NOT EXISTS idx_cognitive_org_shared ON cognitive_records(org_id) WHERE visibility = 'org';
