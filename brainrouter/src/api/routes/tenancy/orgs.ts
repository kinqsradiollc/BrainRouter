/**
 * Organizations API (ADR-010 P1). List the caller's orgs + role/capabilities,
 * manage members (admins only), and switch the default org. URL-param'd org
 * routes resolve the caller's role for THAT org directly (the header-based
 * `requirePermission` targets the active/default org instead).
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { can, capabilitiesFor, isRole, ROLES } from "../../../tenancy/rbac.js";

export const orgsRouter = Router();
orgsRouter.use(requireAnyAuth);

/** GET /api/orgs — the caller's org memberships, with role + capabilities. */
orgsRouter.get("/", async (req: AuthedRequest, res) => {
  try {
    const memberships = await memoryEngine.tenancy.listOrgMembershipsForUser(req.userId!);
    const defaultOrgId = await memoryEngine.tenancy.getDefaultOrgId(req.userId!);
    res.json({
      orgs: memberships.map((m) => ({
        orgId: m.org.orgId,
        name: m.org.name,
        slug: m.org.slug,
        plan: m.org.plan,
        role: m.role,
        capabilities: capabilitiesFor(m.role),
        isDefault: m.org.orgId === defaultOrgId,
      })),
    });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : "Failed to list organizations");
  }
});

/** Resolve the caller's role in `:orgId` and enforce members:manage. */
async function requireMemberAdmin(req: AuthedRequest, res: import("express").Response): Promise<boolean> {
  const orgId = String(req.params.orgId ?? "").trim();
  if (!orgId) {
    sendError(res, 400, "orgId is required");
    return false;
  }
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!can(role, "members:manage")) {
    sendError(res, 403, "This action requires the 'members:manage' capability");
    return false;
  }
  return true;
}

/** GET /api/orgs/:orgId/members — list members (members:manage). */
orgsRouter.get("/:orgId/members", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const members = await memoryEngine.tenancy.listOrgMembers(String(req.params.orgId));
  res.json({ members });
});

/** POST /api/orgs/:orgId/members — add/update a member's role (members:manage). */
orgsRouter.post("/:orgId/members", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const orgId = String(req.params.orgId);
  const userId = String(req.body?.userId ?? "").trim();
  const role = String(req.body?.role ?? "").trim();
  if (!userId || !isRole(role)) {
    sendError(res, 400, `userId and a valid role (${ROLES.join(", ")}) are required`);
    return;
  }
  await memoryEngine.tenancy.addOrgMember(orgId, userId, role);
  res.status(201).json({ orgId, userId, role });
});

/** DELETE /api/orgs/:orgId/members/:userId — remove a member (members:manage). */
orgsRouter.delete("/:orgId/members/:userId", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  await memoryEngine.tenancy.removeOrgMember(String(req.params.orgId), String(req.params.userId));
  res.json({ ok: true });
});

/** POST /api/orgs/:orgId/default — set the caller's default org (must be a member). */
orgsRouter.post("/:orgId/default", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!role) {
    sendError(res, 403, "You are not a member of that organization");
    return;
  }
  await memoryEngine.tenancy.setDefaultOrg(req.userId!, orgId);
  res.json({ ok: true, defaultOrgId: orgId });
});
