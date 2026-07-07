/**
 * Projects + per-project access control (ADR-014 Phase E). Additive — exposed via
 * `memoryEngine.projects`, like the tenancy cast. Access rule: a NON-restricted
 * project is visible to every Team member; a RESTRICTED project only to its
 * project_members plus the Team's owners/admins.
 */
import type { Executor } from "./executor.js";

export interface ProjectRecord {
  projectId: string;
  orgId: string;
  name: string;
  slug: string;
  repoUrl: string | null;
  restricted: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface ProjectMemberRecord {
  projectId: string;
  userId: string;
  role: string;
  createdAt: string;
}

function projRow(r: any): ProjectRecord {
  return {
    projectId: String(r.project_id), orgId: String(r.org_id), name: String(r.name), slug: String(r.slug),
    repoUrl: r.repo_url ? String(r.repo_url) : null, restricted: Boolean(r.restricted),
    createdBy: r.created_by ? String(r.created_by) : null, createdAt: String(r.created_at),
  };
}

export async function createProject(exec: Executor, rec: ProjectRecord): Promise<void> {
  await exec.run(
    `INSERT INTO projects (project_id, org_id, name, slug, repo_url, restricted, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [rec.projectId, rec.orgId, rec.name, rec.slug, rec.repoUrl, rec.restricted, rec.createdBy, rec.createdAt],
  );
}

export async function getProject(exec: Executor, projectId: string): Promise<ProjectRecord | null> {
  const row = await exec.one<any>(`SELECT * FROM projects WHERE project_id = $1`, [projectId]);
  return row ? projRow(row) : null;
}

export async function countProjects(exec: Executor, orgId: string): Promise<number> {
  const row = await exec.one<any>(`SELECT COUNT(*)::int AS n FROM projects WHERE org_id = $1`, [orgId]);
  return Number(row?.n ?? 0);
}

export async function updateProject(
  exec: Executor,
  projectId: string,
  patch: { name?: string; repoUrl?: string | null; restricted?: boolean },
): Promise<ProjectRecord | null> {
  const cur = await getProject(exec, projectId);
  if (!cur) return null;
  const name = patch.name ?? cur.name;
  const repoUrl = patch.repoUrl === undefined ? cur.repoUrl : patch.repoUrl;
  const restricted = patch.restricted === undefined ? cur.restricted : patch.restricted;
  await exec.run(`UPDATE projects SET name=$2, repo_url=$3, restricted=$4 WHERE project_id=$1`, [projectId, name, repoUrl, restricted]);
  return getProject(exec, projectId);
}

export async function deleteProject(exec: Executor, projectId: string): Promise<void> {
  await exec.run(`DELETE FROM projects WHERE project_id = $1`, [projectId]);
}

/** Projects the user may access: non-restricted OR a member OR a Team owner/admin. */
export async function listAccessibleProjects(
  exec: Executor,
  orgId: string,
  userId: string,
  isOrgAdmin: boolean,
): Promise<ProjectRecord[]> {
  const rows = await exec.rows<any>(
    `SELECT p.* FROM projects p
      WHERE p.org_id = $1
        AND ( p.restricted = false OR $3 = true
              OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.project_id AND pm.user_id = $2) )
      ORDER BY p.created_at DESC`,
    [orgId, userId, isOrgAdmin],
  );
  return rows.map(projRow);
}

export async function addProjectMember(exec: Executor, projectId: string, userId: string, role: string, now: string): Promise<void> {
  await exec.run(
    `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [projectId, userId, role, now],
  );
}

export async function removeProjectMember(exec: Executor, projectId: string, userId: string): Promise<void> {
  await exec.run(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
}

export async function listProjectMembers(exec: Executor, projectId: string): Promise<ProjectMemberRecord[]> {
  const rows = await exec.rows<any>(`SELECT project_id, user_id, role, created_at FROM project_members WHERE project_id = $1`, [projectId]);
  return rows.map((r) => ({ projectId: String(r.project_id), userId: String(r.user_id), role: String(r.role), createdAt: String(r.created_at) }));
}
