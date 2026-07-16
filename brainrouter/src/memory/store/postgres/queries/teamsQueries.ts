/**
 * Teams persistence (migration 035). A team is a group of users WITHIN an org —
 * the backing entity behind the `team` meeting-sharing scope (ADR-018), which
 * previously had no real entity (the org was modeled AS "the team"). Every query
 * is keyed by `org_id`, so a team can never be read/mutated from another org, and
 * membership is resolved against that org. Exposed via thin PostgresMemoryStore
 * methods, consumed by memory/teams/backend.ts.
 */
import type { Executor } from "./executor.js";

export type TeamMemberRole = "owner" | "admin" | "member";

export interface TeamRow {
  id: string;
  orgId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberRow {
  teamId: string;
  userId: string;
  role: TeamMemberRole;
  createdAt: string;
}

export interface CreateTeamInput {
  id: string;
  orgId: string;
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

function mapTeam(r: Record<string, unknown>): TeamRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    name: String(r.name ?? ""),
    createdBy: String(r.created_by ?? ""),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function mapMember(r: Record<string, unknown>): TeamMemberRow {
  return {
    teamId: String(r.team_id),
    userId: String(r.user_id),
    role: asRole(r.role),
    createdAt: iso(r.created_at),
  };
}

const TEAM_COLS = `id, org_id, name, created_by, created_at, updated_at`;
const MEMBER_COLS = `team_id, user_id, role, created_at`;

export async function createTeam(exec: Executor, input: CreateTeamInput): Promise<TeamRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO teams (id, org_id, name, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TEAM_COLS}`,
    [input.id, input.orgId, input.name, input.createdBy],
  );
  return mapTeam(row!);
}

/** Teams in `orgId` that `userId` is a member of, newest first. */
export async function listTeamsForUser(exec: Executor, orgId: string, userId: string): Promise<TeamRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT ${TEAM_COLS.split(", ").map((c) => `t.${c}`).join(", ")}
       FROM teams t
       JOIN team_members m ON m.team_id = t.id
      WHERE t.org_id = $1 AND m.user_id = $2
      ORDER BY t.created_at DESC, t.id DESC`,
    [orgId, userId],
  );
  return rows.map(mapTeam);
}

export async function getTeam(exec: Executor, orgId: string, id: string): Promise<TeamRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT ${TEAM_COLS} FROM teams WHERE org_id = $1 AND id = $2`,
    [orgId, id],
  );
  return row ? mapTeam(row) : null;
}

/** True iff a team with `id` exists in `orgId` and `userId` is a member of it. */
export async function isTeamMember(exec: Executor, orgId: string, teamId: string, userId: string): Promise<boolean> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT 1 AS ok
       FROM teams t
       JOIN team_members m ON m.team_id = t.id
      WHERE t.org_id = $1 AND t.id = $2 AND m.user_id = $3`,
    [orgId, teamId, userId],
  );
  return !!row;
}

export async function listTeamMembers(exec: Executor, orgId: string, teamId: string): Promise<TeamMemberRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT ${MEMBER_COLS.split(", ").map((c) => `m.${c}`).join(", ")}
       FROM team_members m
       JOIN teams t ON t.id = m.team_id
      WHERE t.org_id = $1 AND m.team_id = $2
      ORDER BY m.created_at ASC`,
    [orgId, teamId],
  );
  return rows.map(mapMember);
}

/** Add (or upsert the role of) a member. Org-scoped: only touches teams in `orgId`. */
export async function addTeamMember(exec: Executor, orgId: string, teamId: string, userId: string, role: TeamMemberRole = "member"): Promise<boolean> {
  const n = await exec.run(
    `INSERT INTO team_members (team_id, user_id, role)
       SELECT $2, $3, $4 FROM teams t WHERE t.org_id = $1 AND t.id = $2
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, teamId, userId, role],
  );
  return n > 0;
}

export async function removeTeamMember(exec: Executor, orgId: string, teamId: string, userId: string): Promise<boolean> {
  const n = await exec.run(
    `DELETE FROM team_members
      WHERE user_id = $3 AND team_id IN (SELECT id FROM teams WHERE org_id = $1 AND id = $2)`,
    [orgId, teamId, userId],
  );
  return n > 0;
}

/** Delete a team and its membership rows (org-scoped). Returns true if a team was removed. */
export async function deleteTeam(exec: Executor, orgId: string, id: string): Promise<boolean> {
  return exec.tx(async (client) => {
    const res = await client.query(`DELETE FROM teams WHERE org_id = $1 AND id = $2`, [orgId, id]);
    if (!res.rowCount) return false;
    await client.query(`DELETE FROM team_members WHERE team_id = $1`, [id]);
    return true;
  });
}
