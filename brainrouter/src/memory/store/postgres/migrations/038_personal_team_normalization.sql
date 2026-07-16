-- 038_personal_team_normalization — teams created in the hidden personal-org
-- tenancy container are personal collaboration teams, not organization teams.
-- This keeps the product boundary explicit while preserving legacy team ids and
-- their existing shares.

WITH converted AS (
  UPDATE teams t
     SET kind = 'personal', org_id = NULL, owner_user_id = t.created_by, updated_at = now()
   WHERE t.kind = 'organization'
     AND t.org_id = 'org_personal_' || t.created_by
     AND EXISTS (SELECT 1 FROM users u WHERE u.user_id = t.created_by)
  RETURNING t.id, t.created_by
)
INSERT INTO team_members (team_id, user_id, role)
SELECT id, created_by, 'owner' FROM converted
ON CONFLICT (team_id, user_id) DO UPDATE SET role = 'owner';
