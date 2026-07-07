/**
 * Tenancy SQL (ADR-010 P1) — organizations + memberships. Free functions over an
 * `Executor`, mirroring the other query modules. Row → record mappers keep the
 * snake_case DB shape out of the domain layer.
 */
import type { Executor } from "./executor.js";
import type { OrgPlan, OrganizationRecord, OrgMemberRecord, OrgMembership } from "../../../../tenancy/types.js";
import { normalizeOrgPlan } from "../../../../tenancy/types.js";
import { isRole, type Role } from "../../../../tenancy/rbac.js";

const ORG_COLUMNS = "org_id, name, slug, plan, created_at";

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : new Date(0).toISOString();
}

function orgRowToRecord(row: any): OrganizationRecord {
  return {
    orgId: String(row.org_id),
    name: String(row.name),
    slug: String(row.slug),
    plan: normalizeOrgPlan(row.plan),
    createdAt: toIso(row.created_at),
  };
}

function memberRowToRecord(row: any): OrgMemberRecord {
  return {
    orgId: String(row.org_id),
    userId: String(row.user_id),
    role: (isRole(row.role) ? row.role : "viewer") as Role,
    createdAt: toIso(row.created_at),
  };
}

/** The deterministic personal-org id for a user (matches migration 006). */
export function personalOrgId(userId: string): string {
  return `org_personal_${userId}`;
}

export async function createOrganization(
  exec: Executor,
  input: { orgId: string; name: string; slug: string; plan?: OrgPlan; now?: string },
): Promise<OrganizationRecord> {
  const now = input.now ?? new Date().toISOString();
  await exec.run(
    `INSERT INTO organizations (org_id, name, slug, plan, created_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id) DO NOTHING`,
    [input.orgId, input.name, input.slug, input.plan ?? "free", now],
  );
  return (await getOrganization(exec, input.orgId))!;
}

export async function getOrganization(exec: Executor, orgId: string): Promise<OrganizationRecord | null> {
  const row = await exec.one(`SELECT ${ORG_COLUMNS} FROM organizations WHERE org_id = $1`, [orgId]);
  return row ? orgRowToRecord(row) : null;
}

export async function updateOrganizationPlan(
  exec: Executor,
  orgId: string,
  plan: OrgPlan,
): Promise<OrganizationRecord> {
  await exec.run(`UPDATE organizations SET plan = $2 WHERE org_id = $1`, [orgId, plan]);
  const org = await getOrganization(exec, orgId);
  if (!org) throw new Error(`Organization not found: ${orgId}`);
  return org;
}

export async function addOrgMember(
  exec: Executor,
  orgId: string,
  userId: string,
  role: Role,
  now?: string,
): Promise<void> {
  await exec.run(
    `INSERT INTO org_members (org_id, user_id, role, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, userId, role, now ?? new Date().toISOString()],
  );
}

export async function removeOrgMember(exec: Executor, orgId: string, userId: string): Promise<void> {
  await exec.run(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
}

/** The caller's role in an org, or null when they are not a member. */
export async function getMemberRole(exec: Executor, orgId: string, userId: string): Promise<Role | null> {
  const row = await exec.one(`SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
  return row && isRole(row.role) ? (row.role as Role) : null;
}

export async function listOrgMembers(exec: Executor, orgId: string): Promise<OrgMemberRecord[]> {
  const rows = await exec.rows(
    `SELECT org_id, user_id, role, created_at FROM org_members WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  );
  return rows.map(memberRowToRecord);
}

/** Every (org, role) the user belongs to. */
export async function listOrgMembershipsForUser(exec: Executor, userId: string): Promise<OrgMembership[]> {
  const rows = await exec.rows(
    `SELECT o.org_id, o.name, o.slug, o.plan, o.created_at, m.role AS member_role
     FROM org_members m JOIN organizations o ON o.org_id = m.org_id
     WHERE m.user_id = $1 ORDER BY o.created_at ASC`,
    [userId],
  );
  return rows.map((row) => ({
    org: orgRowToRecord(row),
    role: (isRole(row.member_role) ? row.member_role : "viewer") as Role,
  }));
}

export async function setDefaultOrg(exec: Executor, userId: string, orgId: string): Promise<void> {
  await exec.run(`UPDATE users SET default_org_id = $2 WHERE user_id = $1`, [userId, orgId]);
}

export async function getDefaultOrgId(exec: Executor, userId: string): Promise<string | null> {
  const row = await exec.one(`SELECT default_org_id FROM users WHERE user_id = $1`, [userId]);
  return row?.default_org_id ? String(row.default_org_id) : null;
}

/**
 * Ensure a user has their personal org (owner) + it is their default. Idempotent
 * — the signup-time analogue of migration 006's backfill for a brand-new user.
 */
export async function ensurePersonalOrg(
  exec: Executor,
  userId: string,
  displayName?: string,
  now?: string,
): Promise<OrganizationRecord> {
  const orgId = personalOrgId(userId);
  const org = await createOrganization(exec, {
    orgId,
    name: `${(displayName ?? "").trim() || userId} (personal)`,
    slug: `personal-${userId}`,
    plan: "free",
    now,
  });
  await addOrgMember(exec, orgId, userId, "owner", now);
  const current = await getDefaultOrgId(exec, userId);
  if (!current) await setDefaultOrg(exec, userId, orgId);
  return org;
}
