/** Team-space persistence for organization-bound and personal teams. */
import type { Executor } from "./executor.js";

export type TeamKind = "organization" | "personal";
export type TeamMemberRole = "owner" | "admin" | "member";

export interface TeamRow {
  id: string;
  kind: TeamKind;
  orgId: string | null;
  orgName: string | null;
  ownerUserId: string | null;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  myRole?: TeamMemberRole | null;
}

export interface TeamMemberRow {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  displayName: string;
  email: string;
  createdAt: string;
}

export interface CreateTeamInput {
  id: string;
  kind: TeamKind;
  orgId: string | null;
  ownerUserId: string | null;
  name: string;
  createdBy: string;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}
function asRole(value: unknown): TeamMemberRole {
  return value === "owner" || value === "admin" ? value : "member";
}
function asKind(value: unknown): TeamKind {
  return value === "personal" ? "personal" : "organization";
}

function mapTeam(r: Record<string, unknown>): TeamRow {
  return {
    id: String(r.id),
    kind: asKind(r.kind),
    orgId: r.org_id == null ? null : String(r.org_id),
    orgName: r.org_name == null ? null : String(r.org_name),
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    name: String(r.name ?? ""),
    createdBy: String(r.created_by ?? ""),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    ...(r.my_role == null ? {} : { myRole: asRole(r.my_role) }),
  };
}
function mapMember(r: Record<string, unknown>): TeamMemberRow {
  return {
    teamId: String(r.team_id),
    userId: String(r.user_id),
    role: asRole(r.role),
    displayName: String(r.display_name ?? ""),
    email: String(r.email ?? ""),
    createdAt: iso(r.created_at),
  };
}

const TEAM_SELECT = `t.id, t.kind, t.org_id, o.name AS org_name, t.owner_user_id,
  t.name, t.created_by, t.created_at, t.updated_at`;

export async function createTeam(exec: Executor, input: CreateTeamInput): Promise<TeamRow> {
  const row = await exec.one<Record<string, unknown>>(
    `WITH inserted AS (
       INSERT INTO teams (id, kind, org_id, owner_user_id, name, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *
     )
     SELECT t.id, t.kind, t.org_id, o.name AS org_name, t.owner_user_id,
            t.name, t.created_by, t.created_at, t.updated_at
       FROM inserted t LEFT JOIN organizations o ON o.org_id = t.org_id`,
    [input.id, input.kind, input.orgId, input.ownerUserId, input.name, input.createdBy],
  );
  return mapTeam(row!);
}

/** Personal teams follow the user globally; organization teams follow active context. */
export async function listTeamsForUser(exec: Executor, orgId: string, userId: string, includeAllOrgTeams = false): Promise<TeamRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT ${TEAM_SELECT}, mine.role AS my_role
       FROM teams t
       LEFT JOIN organizations o ON o.org_id = t.org_id
       LEFT JOIN team_members mine ON mine.team_id = t.id AND mine.user_id = $2
      WHERE (t.kind = 'personal' AND mine.user_id IS NOT NULL)
         OR (t.kind = 'organization' AND t.org_id = $1 AND ($3 OR mine.user_id IS NOT NULL))
      ORDER BY CASE WHEN t.kind = 'personal' THEN 0 ELSE 1 END, t.created_at DESC, t.id DESC`,
    [orgId, userId, includeAllOrgTeams],
  );
  return rows.map(mapTeam);
}

/** Resolve an organization team in context, or a personal team for membership checks. */
export async function getTeam(exec: Executor, orgId: string, id: string): Promise<TeamRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT ${TEAM_SELECT}
       FROM teams t LEFT JOIN organizations o ON o.org_id = t.org_id
      WHERE t.id = $2 AND ((t.kind = 'organization' AND t.org_id = $1) OR t.kind = 'personal')`,
    [orgId, id],
  );
  return row ? mapTeam(row) : null;
}

export async function isTeamMember(exec: Executor, orgId: string, teamId: string, userId: string): Promise<boolean> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT 1 AS ok FROM teams t JOIN team_members m ON m.team_id = t.id
      WHERE t.id = $2 AND m.user_id = $3
        AND ((t.kind = 'organization' AND t.org_id = $1) OR t.kind = 'personal')`,
    [orgId, teamId, userId],
  );
  return !!row;
}

export async function listTeamMembers(exec: Executor, orgId: string, teamId: string): Promise<TeamMemberRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT m.team_id, m.user_id, m.role, m.created_at, u.display_name, u.email
       FROM team_members m
       JOIN teams t ON t.id = m.team_id
       JOIN users u ON u.user_id = m.user_id
      WHERE m.team_id = $2
        AND ((t.kind = 'organization' AND t.org_id = $1) OR t.kind = 'personal')
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               COALESCE(NULLIF(u.display_name, ''), NULLIF(u.email, ''), u.user_id) ASC`,
    [orgId, teamId],
  );
  return rows.map(mapMember);
}

/** SQL repeats eligibility checks to protect against membership/status races. */
export async function addTeamMember(exec: Executor, orgId: string, teamId: string, userId: string, role: TeamMemberRole = "member"): Promise<boolean> {
  const n = await exec.run(
    `INSERT INTO team_members (team_id, user_id, role)
     SELECT t.id, u.user_id, $4
       FROM teams t
       JOIN users u ON u.user_id = $3 AND u.status = 'active'
       LEFT JOIN org_members om ON om.org_id = t.org_id AND om.user_id = u.user_id
      WHERE t.id = $2
        AND ((t.kind = 'personal') OR (t.kind = 'organization' AND t.org_id = $1 AND om.user_id IS NOT NULL))
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, teamId, userId, role],
  );
  return n > 0;
}

export async function removeTeamMember(exec: Executor, orgId: string, teamId: string, userId: string): Promise<boolean> {
  const n = await exec.run(
    `DELETE FROM team_members
      WHERE user_id = $3 AND team_id IN (
        SELECT id FROM teams WHERE id = $2
          AND ((kind = 'organization' AND org_id = $1) OR kind = 'personal')
      )`,
    [orgId, teamId, userId],
  );
  return n > 0;
}

/** Keep the personal-space lifecycle owner aligned with a real team owner. */
export async function transferPersonalTeamOwnership(exec: Executor, teamId: string, fromUserId: string, toUserId: string): Promise<boolean> {
  const n = await exec.run(
    `UPDATE teams t
        SET owner_user_id = $3, updated_at = now()
      WHERE t.id = $1 AND t.kind = 'personal' AND t.owner_user_id = $2
        AND EXISTS (
          SELECT 1 FROM team_members m
           WHERE m.team_id = t.id AND m.user_id = $3 AND m.role = 'owner'
        )`,
    [teamId, fromUserId, toUserId],
  );
  return n > 0;
}

/** Deleting a team atomically revokes team-only meeting and memory access. */
export async function deleteTeam(exec: Executor, orgId: string, id: string): Promise<boolean> {
  return exec.tx(async (client) => {
    const visible = `id = $2 AND ((kind = 'organization' AND org_id = $1) OR kind = 'personal')`;
    await client.query(`UPDATE meetings SET scope = 'private', team_id = NULL, updated_at = now()
      WHERE team_id IN (SELECT id FROM teams WHERE ${visible})`, [orgId, id]);
    await client.query(`UPDATE cognitive_records SET visibility = 'private', team_id = NULL
      WHERE team_id IN (SELECT id FROM teams WHERE ${visible})`, [orgId, id]);
    const res = await client.query(`DELETE FROM teams WHERE ${visible}`, [orgId, id]);
    if (!res.rowCount) return false;
    await client.query(`DELETE FROM team_members WHERE team_id = $1`, [id]);
    return true;
  });
}
