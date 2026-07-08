/**
 * Projects API (ADR-014 Phase E) — projects/repos within a Team, plan-capped, with
 * per-project access control. Mounted at /api/orgs (alongside orgsRouter). Project
 * CRUD reuses `members:manage`; the `restricted` flag needs the enterprise
 * `restrictedProjects` feature.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { can, roleAtLeast, isRole, ROLES } from "../../../tenancy/rbac.js";
import { planHasFeature, withinLimit, entitlementsFor } from "../../../tenancy/entitlements.js";
import { normalizeRepoUrl } from "@kinqs/brainrouter-core/track";

export const projectsRouter = Router();
projectsRouter.use(requireAnyAuth);

/** GET /api/orgs/:orgId/projects — projects the caller can access. */
projectsRouter.get("/:orgId/projects", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId);
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!req.isAdmin && !role) { sendError(res, 403, "You are not a member of that team"); return; }
  // Global admins see every project (parity with requirePermission's admin bypass).
  const seeAll = !!req.isAdmin || roleAtLeast(role, "admin");
  let projects = await memoryEngine.projects.listAccessibleProjects(orgId, req.userId!, seeAll);
  // ADR-015 — `repoUrl` is finally consumed: `?repo=<git remote>` resolves which
  // project a local checkout maps to, matching on the canonical repo identity so an
  // ssh `git@…` workspace remote matches an https linked url (and vice-versa).
  const repo = String(req.query.repo ?? "").trim();
  if (repo) {
    const want = normalizeRepoUrl(repo);
    projects = want ? projects.filter((p) => normalizeRepoUrl(p.repoUrl ?? "") === want) : [];
  }
  res.json({ projects });
});

/** POST /api/orgs/:orgId/projects { name, repoUrl?, restricted? } — create (members:manage). */
projectsRouter.post("/:orgId/projects", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId);
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!req.isAdmin && !can(role, "members:manage")) { sendError(res, 403, "This action requires the 'members:manage' capability"); return; }
  const name = String(req.body?.name ?? "").trim();
  if (!name) { sendError(res, 400, "name is required"); return; }
  const restricted = Boolean(req.body?.restricted);
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org) { sendError(res, 404, "team not found"); return; }
  // Plan cap on project count.
  const count = await memoryEngine.projects.countProjects(orgId);
  if (!withinLimit(org.plan, "projects", count)) {
    const cap = entitlementsFor(org.plan).limits.projects;
    sendError(res, 402, `The ${org.plan} plan allows ${cap} projects. Upgrade to add more.`); return;
  }
  if (restricted && !planHasFeature(org.plan, "restrictedProjects")) {
    sendError(res, 402, "Restricting a project to specific members requires the enterprise plan."); return;
  }
  const projectId = `proj_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "project") + "-" + randomUUID().slice(0, 6);
  const now = new Date().toISOString();
  try {
    await memoryEngine.projects.createProject({
      projectId, orgId, name, slug,
      repoUrl: String(req.body?.repoUrl ?? "").trim() || null,
      restricted, createdBy: req.userId!, createdAt: now,
    });
    const project = await memoryEngine.projects.getProject(projectId);
    res.status(201).json({ project });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to create project");
  }
});

/** Resolve the project + assert the caller manages its Team. */
async function requireProjectAdmin(req: AuthedRequest, res: import("express").Response) {
  const orgId = String(req.params.orgId);
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!req.isAdmin && !can(role, "members:manage")) { sendError(res, 403, "This action requires the 'members:manage' capability"); return null; }
  const project = await memoryEngine.projects.getProject(String(req.params.projectId));
  if (!project || project.orgId !== orgId) { sendError(res, 404, "project not found"); return null; }
  return { orgId, project };
}

/** PATCH /api/orgs/:orgId/projects/:projectId — rename / set repo / toggle restricted. */
projectsRouter.patch("/:orgId/projects/:projectId", async (req: AuthedRequest, res) => {
  const ctx = await requireProjectAdmin(req, res);
  if (!ctx) return;
  const patch: { name?: string; repoUrl?: string | null; restricted?: boolean } = {};
  if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
  if (typeof req.body?.repoUrl === "string") patch.repoUrl = req.body.repoUrl.trim() || null;
  if (typeof req.body?.restricted === "boolean") {
    const org = await memoryEngine.tenancy.getOrganization(ctx.orgId);
    if (req.body.restricted && !(org && planHasFeature(org.plan, "restrictedProjects"))) {
      sendError(res, 402, "Restricting a project requires the enterprise plan."); return;
    }
    patch.restricted = req.body.restricted;
  }
  const project = await memoryEngine.projects.updateProject(ctx.project.projectId, patch);
  res.json({ project });
});

/** DELETE /api/orgs/:orgId/projects/:projectId. */
projectsRouter.delete("/:orgId/projects/:projectId", async (req: AuthedRequest, res) => {
  const ctx = await requireProjectAdmin(req, res);
  if (!ctx) return;
  await memoryEngine.projects.deleteProject(ctx.project.projectId);
  res.json({ ok: true });
});

/** GET/POST/DELETE project members (members:manage) — for restricted-project access. */
projectsRouter.get("/:orgId/projects/:projectId/members", async (req: AuthedRequest, res) => {
  const ctx = await requireProjectAdmin(req, res);
  if (!ctx) return;
  const members = await memoryEngine.projects.listProjectMembers(ctx.project.projectId);
  res.json({ members });
});

projectsRouter.post("/:orgId/projects/:projectId/members", async (req: AuthedRequest, res) => {
  const ctx = await requireProjectAdmin(req, res);
  if (!ctx) return;
  const userId = String(req.body?.userId ?? "").trim();
  const role = String(req.body?.role ?? "member").trim();
  if (!userId) { sendError(res, 400, "userId is required"); return; }
  if (!isRole(role)) { sendError(res, 400, `a valid role (${ROLES.join(", ")}) is required`); return; }
  // The user must belong to the Team first.
  const memberRole = await memoryEngine.tenancy.getMemberRole(ctx.orgId, userId);
  if (!memberRole) { sendError(res, 400, "That user is not a member of the team"); return; }
  await memoryEngine.projects.addProjectMember(ctx.project.projectId, userId, role, new Date().toISOString());
  res.status(201).json({ ok: true, projectId: ctx.project.projectId, userId, role });
});

projectsRouter.delete("/:orgId/projects/:projectId/members/:userId", async (req: AuthedRequest, res) => {
  const ctx = await requireProjectAdmin(req, res);
  if (!ctx) return;
  await memoryEngine.projects.removeProjectMember(ctx.project.projectId, String(req.params.userId));
  res.json({ ok: true });
});
