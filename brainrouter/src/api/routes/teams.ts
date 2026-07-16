/** Teams API for organization-bound and cross-organization personal teams. */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import { roleAtLeast } from "../../tenancy/rbac.js";
import { memoryEngine } from "../../memory/engine.js";
import * as teams from "../../memory/teams/backend.js";
import { personalOrgId } from "../../memory/store/postgres/queries/tenancyQueries.js";

export const teamsRouter = Router();
teamsRouter.use(requireAnyAuth);

function orgOverride(req: AuthedRequest, team: teams.TeamRow): boolean {
  return team.kind === "organization" && team.orgId === req.orgId && (req.isAdmin === true || roleAtLeast(req.role, "admin"));
}
function mine(members: teams.TeamMemberRow[], userId: string | undefined): teams.TeamMemberRow | undefined {
  return members.find((member) => member.userId === userId);
}
function managerRole(role: teams.TeamMemberRole | undefined): boolean { return role === "owner" || role === "admin"; }
function apiTeam(team: teams.TeamRow, myRole: teams.TeamMemberRole | null, canManage: boolean) {
  return { ...team, myRole, canManage };
}

async function detailForCaller(req: AuthedRequest, id: string): Promise<{
  team: teams.TeamRow; members: teams.TeamMemberRow[]; myRole: teams.TeamMemberRole | null; isOrgAdmin: boolean;
} | null> {
  const team = await teams.getTeam(req.orgId!, id);
  if (!team) return null;
  const isOrgAdmin = orgOverride(req, team);
  const members = await teams.listMembers(req.orgId!, id, req.userId!, isOrgAdmin);
  const myRole = mine(members, req.userId)?.role ?? null;
  if (!isOrgAdmin && !myRole) return null;
  return { team, members, myRole, isOrgAdmin };
}

teamsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const includeAllOrgTeams = req.isAdmin === true || roleAtLeast(req.role, "admin");
  const rows = await teams.listTeams(req.orgId!, req.userId!, includeAllOrgTeams);
  res.json({
    teams: rows.map((team) => {
      const myRole = team.myRole ?? null;
      return apiTeam(team, myRole, orgOverride(req, team) || managerRole(myRole ?? undefined));
    }),
  });
});

teamsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) { res.status(400).json({ error: "name is required" }); return; }
  if (body.kind !== undefined && body.kind !== "organization" && body.kind !== "personal") {
    res.status(400).json({ error: "kind must be organization or personal" }); return;
  }
  if (body.kind !== "personal" && req.orgId === personalOrgId(req.userId!)) {
    res.status(409).json({ error: "Organization teams require a shared organization. Use a personal team in your personal workspace." }); return;
  }
  try {
    const team = await teams.createTeam(req.orgId!, req.userId!, body.name, body.kind === "personal" ? "personal" : "organization");
    res.status(201).json({ team: apiTeam(team, "owner", true) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Could not create team" });
  }
});

teamsRouter.get("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const detail = await detailForCaller(req, String(req.params.id));
  if (!detail) { res.status(404).json({ error: "Team not found" }); return; }
  res.json({
    team: apiTeam(detail.team, detail.myRole, detail.isOrgAdmin || managerRole(detail.myRole ?? undefined)),
    members: detail.members,
    currentUserId: req.userId,
  });
});

teamsRouter.post("/:id/members", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const detail = await detailForCaller(req, id);
  if (!detail) { res.status(404).json({ error: "Team not found" }); return; }
  if (!(detail.isOrgAdmin || managerRole(detail.myRole ?? undefined))) {
    res.status(403).json({ error: "This action requires team owner/admin or organization admin" }); return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const requestedUserId = typeof body.userId === "string" ? body.userId.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!requestedUserId && !email) { res.status(400).json({ error: "userId or email is required" }); return; }
  const target = requestedUserId
    ? await memoryEngine.getUserById(requestedUserId)
    : await memoryEngine.getUserByEmail(email);
  if (!target || target.status !== "active") { res.status(404).json({ error: "No active registered account matches that user ID or email" }); return; }

  if (detail.team.kind === "organization") {
    const memberRole = await memoryEngine.tenancy.getMemberRole(detail.team.orgId!, target.userId);
    if (!memberRole) {
      res.status(409).json({ error: "Organization teams can include only members of this organization. Invite this person to the organization first, or use a personal team." }); return;
    }
  }

  const role: teams.TeamMemberRole = body.role === "owner" || body.role === "admin" ? body.role : "member";
  const targetExisting = mine(detail.members, target.userId);
  if (role === "owner" && !(detail.isOrgAdmin || detail.myRole === "owner")) {
    res.status(403).json({ error: "Only a team owner or organization admin can grant the owner role" }); return;
  }
  if (targetExisting?.role === "owner" && role !== "owner") {
    if (!(detail.isOrgAdmin || detail.myRole === "owner")) {
      res.status(403).json({ error: "Only a team owner or organization admin can change an owner" }); return;
    }
    if (detail.members.filter((member) => member.role === "owner").length <= 1) {
      res.status(400).json({ error: "A team must keep at least one owner" }); return;
    }
  }

  if (detail.team.kind === "personal" && detail.team.ownerUserId === target.userId && targetExisting?.role === "owner" && role !== "owner") {
    const successor = detail.members.find((member) => member.userId !== target.userId && member.role === "owner");
    if (!successor || !(await teams.transferPersonalTeamOwnership(id, target.userId, successor.userId))) {
      res.status(409).json({ error: "Could not transfer personal-team ownership" }); return;
    }
  }

  const ok = await teams.addMember(req.orgId!, id, target.userId, role, req.userId!, detail.isOrgAdmin);
  if (!ok) { res.status(409).json({ error: "The account is not eligible to join this team" }); return; }
  res.json({ ok: true, members: await teams.listMembers(req.orgId!, id, req.userId!, detail.isOrgAdmin) });
});

teamsRouter.delete("/:id/members/:userId", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const targetUserId = String(req.params.userId);
  const detail = await detailForCaller(req, id);
  if (!detail) { res.status(404).json({ error: "Team not found" }); return; }
  const selfLeave = targetUserId === req.userId;
  if (!(selfLeave || detail.isOrgAdmin || managerRole(detail.myRole ?? undefined))) {
    res.status(403).json({ error: "This action requires team owner/admin or organization admin" }); return;
  }
  const target = mine(detail.members, targetUserId);
  if (!target) { res.json({ ok: false }); return; }
  if (target.role === "owner") {
    if (!(selfLeave || detail.isOrgAdmin || detail.myRole === "owner")) {
      res.status(403).json({ error: "Only a team owner or organization admin can remove an owner" }); return;
    }
    if (detail.members.filter((member) => member.role === "owner").length <= 1) {
      res.status(400).json({ error: "Transfer ownership before the last owner leaves" }); return;
    }
  }
  if (detail.team.kind === "personal" && detail.team.ownerUserId === targetUserId) {
    const successor = detail.members.find((member) => member.userId !== targetUserId && member.role === "owner");
    if (!successor || !(await teams.transferPersonalTeamOwnership(id, targetUserId, successor.userId))) {
      res.status(409).json({ error: "Could not transfer personal-team ownership" }); return;
    }
  }
  const ok = await teams.removeMember(req.orgId!, id, targetUserId, req.userId!, detail.isOrgAdmin);
  res.json({ ok });
});

teamsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const detail = await detailForCaller(req, id);
  if (!detail) { res.status(404).json({ error: "Team not found" }); return; }
  if (!(detail.isOrgAdmin || managerRole(detail.myRole ?? undefined))) {
    res.status(403).json({ error: "This action requires team owner/admin or organization admin" }); return;
  }
  res.json({ ok: await teams.deleteTeam(req.orgId!, id) });
});
