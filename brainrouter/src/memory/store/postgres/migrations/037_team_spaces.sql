-- 037_team_spaces — distinguish organization teams from personal collaboration teams.
-- Existing rows remain organization teams. Personal-team membership never implies
-- organization membership; resource access is checked explicitly through team_members.

ALTER TABLE teams ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'organization';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE teams ALTER COLUMN org_id DROP NOT NULL;

UPDATE teams SET kind = 'organization' WHERE kind IS NULL OR kind NOT IN ('organization', 'personal');
UPDATE teams SET owner_user_id = NULL WHERE kind = 'organization';

-- Remove legacy dangling memberships before adding real referential integrity.
DELETE FROM team_members tm WHERE NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = tm.team_id);
DELETE FROM team_members tm WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.user_id = tm.user_id);

-- An organization team may contain only organization members. This closes the
-- pre-037 path that accepted an arbitrary registered user ID.
DELETE FROM team_members tm
USING teams t
WHERE t.id = tm.team_id
  AND t.kind = 'organization'
  AND NOT EXISTS (
    SELECT 1 FROM org_members om WHERE om.org_id = t.org_id AND om.user_id = tm.user_id
  );

DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT teams_kind_check CHECK (kind IN ('organization', 'personal'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT teams_container_check CHECK (
    (kind = 'organization' AND org_id IS NOT NULL AND owner_user_id IS NULL)
    OR (kind = 'personal' AND org_id IS NULL AND owner_user_id IS NOT NULL)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT teams_org_fk FOREIGN KEY (org_id)
    REFERENCES organizations(org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE teams ADD CONSTRAINT teams_owner_fk FOREIGN KEY (owner_user_id)
    REFERENCES users(user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE team_members ADD CONSTRAINT team_members_team_fk FOREIGN KEY (team_id)
    REFERENCES teams(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE team_members ADD CONSTRAINT team_members_user_fk FOREIGN KEY (user_id)
    REFERENCES users(user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE team_members ADD CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'member'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_teams_kind_org ON teams(kind, org_id);
CREATE INDEX IF NOT EXISTS idx_teams_personal_owner ON teams(owner_user_id) WHERE kind = 'personal';

-- Team deletion is a revocation event. The backend makes the meeting private in
-- the same transaction; SET NULL is defense in depth for administrative deletes.
UPDATE meetings m SET scope = 'private', team_id = NULL, updated_at = now()
WHERE m.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = m.team_id);
UPDATE cognitive_records c SET visibility = 'private', team_id = NULL
WHERE c.team_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = c.team_id);

DO $$ BEGIN
  ALTER TABLE meetings ADD CONSTRAINT meetings_team_fk FOREIGN KEY (team_id)
    REFERENCES teams(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
