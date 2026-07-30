/** Team-space domain layer: organization teams and cross-org personal teams. */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import type {
  CreateTeamInput, TeamKind, TeamMemberRole, TeamMemberRow, TeamRow,
} from "../store/postgres/queries/teamsQueries.js";

interface TeamsStore {
  createTeam(input: CreateTeamInput): Promise<TeamRow>;
  listTeamsForUser(orgId: string, userId: string, includeAllOrgTeams?: boolean): Promise<TeamRow[]>;
  getTeam(orgId: string, id: string): Promise<TeamRow | null>;
  isTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean>;
  listTeamMembers(orgId: string, teamId: string, callerUserId: string, canViewAllOrgTeams?: boolean): Promise<TeamMemberRow[]>;
  insertTeamOwner(teamId: string, userId: string): Promise<boolean>;
  addTeamMember(orgId: string, teamId: string, userId: string, role: TeamMemberRole | undefined, callerUserId: string, canManageOrgTeams?: boolean): Promise<boolean>;
  removeTeamMember(orgId: string, teamId: string, userId: string, callerUserId: string, canManageOrgTeams?: boolean): Promise<boolean>;
  transferPersonalTeamOwnership(teamId: string, fromUserId: string, toUserId: string): Promise<boolean>;
  deleteTeam(orgId: string, id: string): Promise<boolean>;
}
const store = (): TeamsStore => memoryEngine.store as unknown as TeamsStore;

export type { TeamKind, TeamRow, TeamMemberRow, TeamMemberRole } from "../store/postgres/queries/teamsQueries.js";

export class TeamMembershipError extends Error {
  constructor(message = "You are not a member of that team, or it is not available in this context.") {
    super(message);
    this.name = "TeamMembershipError";
  }
}

const MAX_NAME = 200;

export async function listTeams(orgId: string, userId: string, includeAllOrgTeams = false): Promise<TeamRow[]> {
  return store().listTeamsForUser(orgId, userId, includeAllOrgTeams);
}
export async function getTeam(orgId: string, id: string): Promise<TeamRow | null> { return store().getTeam(orgId, id); }
export async function listMembers(orgId: string, teamId: string, callerUserId: string, canViewAllOrgTeams = false): Promise<TeamMemberRow[]> {
  return store().listTeamMembers(orgId, teamId, callerUserId, canViewAllOrgTeams);
}

export async function createTeam(orgId: string, userId: string, name: string, kind: TeamKind = "organization"): Promise<TeamRow> {
  const clean = (name ?? "").trim().slice(0, MAX_NAME);
  if (!clean) throw new Error("Team name is required");
  const personal = kind === "personal";
  const team = await store().createTeam({
    id: `team_${randomUUID()}`,
    kind,
    orgId: personal ? null : orgId,
    ownerUserId: personal ? userId : null,
    name: clean,
    createdBy: userId,
  });
  await store().insertTeamOwner(team.id, userId);
  return team;
}

export async function addMember(orgId: string, teamId: string, userId: string, role: TeamMemberRole = "member", callerUserId: string, canManageOrgTeams = false): Promise<boolean> {
  return store().addTeamMember(orgId, teamId, userId, role, callerUserId, canManageOrgTeams);
}
export async function removeMember(orgId: string, teamId: string, userId: string, callerUserId: string, canManageOrgTeams = false): Promise<boolean> {
  return store().removeTeamMember(orgId, teamId, userId, callerUserId, canManageOrgTeams);
}
export async function transferPersonalTeamOwnership(teamId: string, fromUserId: string, toUserId: string): Promise<boolean> {
  return store().transferPersonalTeamOwnership(teamId, fromUserId, toUserId);
}
export async function deleteTeam(orgId: string, id: string): Promise<boolean> { return store().deleteTeam(orgId, id); }
export async function isTeamMember(orgId: string, teamId: string, userId: string): Promise<boolean> { return store().isTeamMember(orgId, teamId, userId); }

/** A share target may be a same-org organization team or any personal team the owner belongs to. */
export async function assertUserInTeam(orgId: string, userId: string, teamId: string): Promise<void> {
  if (!teamId || !(await store().isTeamMember(orgId, teamId, userId))) throw new TeamMembershipError();
}

/** Organization admins may share same-org resources to any organization team,
 * while personal teams always require real membership. */
export async function assertUserCanShareToTeam(orgId: string, userId: string, teamId: string, canManageOrgTeams = false): Promise<void> {
  if (teamId && await store().isTeamMember(orgId, teamId, userId)) return;
  if (canManageOrgTeams && teamId) {
    const team = await store().getTeam(orgId, teamId);
    if (team?.kind === "organization" && team.orgId === orgId) return;
  }
  throw new TeamMembershipError();
}
