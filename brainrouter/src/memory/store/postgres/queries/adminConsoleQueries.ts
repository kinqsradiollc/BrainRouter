/**
 * Admin console + audit trail (ADR-014 Phase F). System-admin oversight of every
 * Team (plan, seats used, projects, owner) + a tenancy audit log. Additive —
 * exposed via `memoryEngine.adminConsole`.
 */
import type { Executor } from "./executor.js";

export interface OrgStatsRow {
  orgId: string;
  name: string;
  slug: string;
  plan: string;
  memberCount: number;
  projectCount: number;
  ownerId: string | null;
  createdAt: string;
}

export interface OrgAuditRow {
  id: number;
  orgId: string;
  actorId: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  createdAt: string;
}

/** Every Team with membership + project counts + its owner (system-admin only). */
export async function listAllOrgsWithStats(exec: Executor, limit = 500): Promise<OrgStatsRow[]> {
  const rows = await exec.rows<any>(
    `SELECT o.org_id, o.name, o.slug, o.plan, o.created_at,
            (SELECT COUNT(*)::int FROM org_members m WHERE m.org_id = o.org_id) AS member_count,
            (SELECT COUNT(*)::int FROM projects p WHERE p.org_id = o.org_id) AS project_count,
            (SELECT m2.user_id FROM org_members m2 WHERE m2.org_id = o.org_id AND m2.role = 'owner' ORDER BY m2.created_at ASC LIMIT 1) AS owner_id
       FROM organizations o
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    orgId: String(r.org_id), name: String(r.name), slug: String(r.slug), plan: String(r.plan),
    memberCount: Number(r.member_count ?? 0), projectCount: Number(r.project_count ?? 0),
    ownerId: r.owner_id ? String(r.owner_id) : null, createdAt: String(r.created_at ?? ""),
  }));
}

export async function logOrgAudit(
  exec: Executor,
  rec: { orgId: string; actorId?: string | null; action: string; target?: string | null; detail?: string | null; createdAt: string },
): Promise<void> {
  await exec.run(
    `INSERT INTO org_audit_log (org_id, actor_id, action, target, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [rec.orgId, rec.actorId ?? null, rec.action, rec.target ?? null, rec.detail ?? null, rec.createdAt],
  );
}

export async function listOrgAudit(exec: Executor, orgId: string, limit = 100): Promise<OrgAuditRow[]> {
  const rows = await exec.rows<any>(
    `SELECT id, org_id, actor_id, action, target, detail, created_at FROM org_audit_log
      WHERE org_id = $1 ORDER BY id DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), orgId: String(r.org_id), actorId: r.actor_id ? String(r.actor_id) : null,
    action: String(r.action), target: r.target ? String(r.target) : null, detail: r.detail ? String(r.detail) : null,
    createdAt: String(r.created_at ?? ""),
  }));
}
