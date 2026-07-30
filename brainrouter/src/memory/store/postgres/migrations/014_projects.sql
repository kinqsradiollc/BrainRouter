-- 014_projects (ADR-014 Phase E) — projects/repos as first-class entities within a
-- Team, with per-project access control. Until now "project" was only a free-text
-- tag on records; this adds real rows so a Team can (a) cap projects by plan and
-- (b) restrict a project to specific members (enterprise `restrictedProjects`).

CREATE TABLE IF NOT EXISTS projects (
  project_id text PRIMARY KEY,
  org_id     text NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       text NOT NULL,
  repo_url   text,
  -- When true, only project_members (+ org owners/admins) may access it. When
  -- false (default), every Team member has access.
  restricted boolean NOT NULL DEFAULT false,
  created_by text,
  created_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_org_slug ON projects(org_id, slug);

CREATE TABLE IF NOT EXISTS project_members (
  project_id text NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  role       text NOT NULL DEFAULT 'member',
  created_at text NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
