/**
 * Teams API — authenticated, org-scoped CRUD for teams (migration 035). A team is
 * a group of users WITHIN an org; it backs the `team` meeting-sharing scope
 * (ADR-018). Any member may list their own teams and read a team they belong to;
 * creating a team, and managing its membership or deleting it, is gated to a team
 * owner/admin OR an org admin/owner. Every query is keyed by the caller's org, so
 * cross-org access is impossible.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import { roleAtLeast } from "../../tenancy/rbac.js";
import * as teams from "../../memory/teams/backend.js";

export const teamsRouter = Router();
teamsRouter.use(requireAnyAuth);

/** True when the caller may manage `teamId`: a team owner/admin, or an org admin/owner. */
async function canManage(req: AuthedRequest, teamId: string): Promise<boolean> {
  if (roleAtLeast(req.role, "admin")) return true; // org admin/owner
  const members = await teams.listMembers(req.orgId!, teamId);
  const mine = members.find((m) => m.userId === req.userId);
  return mine?.role === "owner" || mine?.role === "admin";
}

// GET / — the teams in the active org that the caller belongs to.
teamsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ teams: await teams.listTeams(req.orgId!, req.userId!) });
});

// POST / — create a team (creator auto-added as an owner member).
teamsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== "string" || !body.name.trim()) { res.status(400).json({ error: "name is required" }); return; }
  try {
    const team = await teams.createTeam(req.orgId!, req.userId!, body.name);
    res.status(201).json({ team });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Could not create team" });
  }
});

// GET /:id — a team the caller belongs to, plus its members.
teamsRouter.get("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const team = await teams.getTeam(req.orgId!, id);
  if (!team) { res.status(404).json({ error: "Team not found" }); return; }
  // A member (or an org admin) may view; otherwise it's invisible to them.
  if (!roleAtLeast(req.role, "admin") && !(await teams.isTeamMember(req.orgId!, id, req.userId!))) {
    res.status(404).json({ error: "Team not found" }); return;
  }
  res.json({ team, members: await teams.listMembers(req.orgId!, id) });
});

// POST /:id/members {userId, role} — add/update a member. Manager-gated, and the
// OWNER role can only be granted by a team owner or an org admin/owner — a team
// admin must not be able to promote itself or anyone to owner (CWE-863 escalation).
teamsRouter.post("/:id/members", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const team = await teams.getTeam(req.orgId!, id);
  if (!team) { res.status(404).json({ error: "Team not found" }); return; }
  const members = await teams.listMembers(req.orgId!, id);
  const isOrgAdmin = roleAtLeast(req.role, "admin");
  const myRole = members.find((m) => m.userId === req.userId)?.role;
  if (!(isOrgAdmin || myRole === "owner" || myRole === "admin")) { res.status(403).json({ error: "This action requires team owner/admin or org admin" }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.userId !== "string" || !body.userId.trim()) { res.status(400).json({ error: "userId is required" }); return; }
  const role = body.role === "owner" || body.role === "admin" ? body.role : "member";
  // Least privilege: only a team owner or an org admin/owner may grant OWNER.
  if (role === "owner" && !(isOrgAdmin || myRole === "owner")) { res.status(403).json({ error: "Only a team owner or an org admin can grant the owner role" }); return; }
  const ok = await teams.addMember(req.orgId!, id, body.userId.trim(), role);
  if (!ok) { res.status(404).json({ error: "Team not found" }); return; }
  res.json({ ok: true, members: await teams.listMembers(req.orgId!, id) });
});

// DELETE /:id/members/:userId — remove a member. Manager-gated; removing an OWNER
// requires team-owner/org-admin (a team admin can't remove an owner), and the last
// owner can't be removed (no lockout).
teamsRouter.delete("/:id/members/:userId", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const team = await teams.getTeam(req.orgId!, id);
  if (!team) { res.status(404).json({ error: "Team not found" }); return; }
  const members = await teams.listMembers(req.orgId!, id);
  const isOrgAdmin = roleAtLeast(req.role, "admin");
  const myRole = members.find((m) => m.userId === req.userId)?.role;
  if (!(isOrgAdmin || myRole === "owner" || myRole === "admin")) { res.status(403).json({ error: "This action requires team owner/admin or org admin" }); return; }
  const targetUserId = String(req.params.userId);
  const target = members.find((m) => m.userId === targetUserId);
  if (target?.role === "owner") {
    if (!(isOrgAdmin || myRole === "owner")) { res.status(403).json({ error: "Only a team owner or an org admin can remove an owner" }); return; }
    if (members.filter((m) => m.role === "owner").length <= 1) { res.status(400).json({ error: "A team must keep at least one owner" }); return; }
  }
  const ok = await teams.removeMember(req.orgId!, id, targetUserId);
  res.json({ ok });
});

// DELETE /:id — delete the team. Manager-gated.
teamsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const id = String(req.params.id);
  const team = await teams.getTeam(req.orgId!, id);
  if (!team) { res.status(404).json({ error: "Team not found" }); return; }
  if (!(await canManage(req, id))) { res.status(403).json({ error: "This action requires team owner/admin or org admin" }); return; }
  const ok = await teams.deleteTeam(req.orgId!, id);
  res.json({ ok });
});
