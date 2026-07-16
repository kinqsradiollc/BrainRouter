/**
 * Teams backend — the data plane behind /api/teams. A team is a group of users
 * WITHIN an org (migration 035); it is the real entity behind the `team`
 * meeting-sharing scope (ADR-018), which previously had no backing entity. Every
 * function is org-scoped, so a team can never be read/mutated across org
 * boundaries and membership is always resolved against the caller's org.
 */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import type {
  CreateTeamInput, TeamMemberRole, TeamMemberRow, TeamRow,
} from "../store/postgres/queries/teamsQueries.js";

interface TeamsStore {
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  listTeamsForUser(orgId: string, userId: string): Promise<TeamRow[]>;
  getTeam(orgId: string, id: string): Promise<TeamRow | null>;
  isTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean>;
  listTeamMembers(orgId: string, teamId: string): Promise<TeamMemberRow[]>;
  addTeamMember(orgId: string, teamId: string, userId: string, role?: TeamMemberRole): Promise<boolean>;
  removeTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean>;
  deleteTeam(orgId: string, id: string): Promise<boolean>;
}
const store = (): TeamsStore => memoryEngine.store as unknown as TeamsStore;

export type { TeamRow, TeamMemberRow, TeamMemberRole } from "../store/postgres/queries/teamsQueries.js";

/** Raised when a `team`-scoped action names a team that isn't in the org, or that
 *  the user isn't a member of. Callers surface this as a 400. */
export class TeamMembershipError extends Error {
  constructor(message = "You are not a member of that team, or it does not exist in this organization.") {
    super(message);
    this.name = "TeamMembershipError";
  }
}

const MAX_NAME = 200;

export async function listTeams(orgId: string, userId: string): Promise<TeamRow[]> {
  return store().listTeamsForUser(orgId, userId);
}

export async function getTeam(orgId: string, id: string): Promise<TeamRow | null> {
  return store().getTeam(orgId, id);
}

export async function listMembers(orgId: string, teamId: string): Promise<TeamMemberRow[]> {
  return store().listTeamMembers(orgId, teamId);
}

/** Create a team in the caller's org; the creator is auto-added as the `owner` member. */
export async function createTeam(orgId: string, userId: string, name: string): Promise<TeamRow> {
  const clean = (name ?? "").trim().slice(0, MAX_NAME);
  if (!clean) throw new Error("Team name is required");
  const team = await store().createTeam({ id: `team_${randomUUID()}`, orgId, name: clean, createdBy: userId });
  await store().addTeamMember(orgId, team.id, userId, "owner");
  return team;
}

export async function addMember(orgId: string, teamId: string, userId: string, role: TeamMemberRole = "member"): Promise<boolean> {
  return store().addTeamMember(orgId, teamId, userId, role);
}

export async function removeMember(orgId: string, teamId: string, userId: string): Promise<boolean> {
  return store().removeTeamMember(orgId, teamId, userId);
}

export async function deleteTeam(orgId: string, id: string): Promise<boolean> {
  return store().deleteTeam(orgId, id);
}

export async function isTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean> {
  return store().isTeamMember(orgId, teamId, userId);
}

/**
 * Guard for `team`-scoped sharing: throws {@link TeamMembershipError} unless the
 * team exists in `orgId` AND `userId` is a member of it. Used by meeting sharing so
 * a meeting can only be team-shared to a real team the caller belongs to.
 */
export async function assertUserInTeam(orgId: string, userId: string, teamId: string): Promise<void> {
  if (!teamId || !(await store().isTeamMember(orgId, teamId, userId))) {
    throw new TeamMembershipError();
  }
}
