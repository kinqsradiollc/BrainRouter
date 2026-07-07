/**
 * Organizations API (ADR-010 P1). List the caller's orgs + role/capabilities,
 * manage members (admins only), and switch the default org. URL-param'd org
 * routes resolve the caller's role for THAT org directly (the header-based
 * `requirePermission` targets the active/default org instead).
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { can, capabilitiesFor, isRole, ROLES } from "../../../tenancy/rbac.js";
import { isOrgPlan, ORG_PLANS } from "../../../tenancy/types.js";

export const orgsRouter = Router();
orgsRouter.use(requireAnyAuth);

/** POST /api/orgs — create a new organization; the caller becomes its owner. */
orgsRouter.post("/", async (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) { sendError(res, 400, "name is required"); return; }
  // Plan is optional; if supplied it must be one of the known tiers. Defaults to
  // "team" (the shared-team tier) to preserve the prior create behaviour.
  const rawPlan = req.body?.plan;
  if (rawPlan !== undefined && !isOrgPlan(rawPlan)) {
    sendError(res, 400, `plan must be one of: ${ORG_PLANS.join(", ")}`);
    return;
  }
  const plan = isOrgPlan(rawPlan) ? rawPlan : "team";
  const orgId = `org_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "org";
  const slug = `${base}-${randomUUID().slice(0, 6)}`;
  try {
    const org = await memoryEngine.tenancy.createOrganization({ orgId, name, slug, plan });
    await memoryEngine.tenancy.addOrgMember(orgId, req.userId!, "owner");
    res.status(201).json({
      org: { orgId: org.orgId, name: org.name, slug: org.slug, plan: org.plan, role: "owner", capabilities: capabilitiesFor("owner"), isDefault: false },
    });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to create organization");
  }
});

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

/**
 * POST /api/orgs/:orgId/members — invite/add a member by `email` (resolved to an
 * existing user) or `userId`, with a role (members:manage). Inviting an email
 * that has no account yet returns 404 — the person must sign up first.
 */
orgsRouter.post("/:orgId/members", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const orgId = String(req.params.orgId);
  const role = String(req.body?.role ?? "").trim();
  if (!isRole(role)) {
    sendError(res, 400, `a valid role (${ROLES.join(", ")}) is required`);
    return;
  }
  let userId = String(req.body?.userId ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  if (!userId && email) {
    const user = await memoryEngine.getUserByEmail(email);
    if (!user) {
      sendError(res, 404, `No user with email ${email}. They must create an account before they can be added.`);
      return;
    }
    userId = user.userId;
  }
  if (!userId) {
    sendError(res, 400, "userId or email is required");
    return;
  }
  await memoryEngine.tenancy.addOrgMember(orgId, userId, role);
  res.status(201).json({ orgId, userId, role, email: email || undefined });
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

/** POST /api/orgs/:orgId/plan — change the org's plan tier (org:manage, i.e. owner). */
orgsRouter.post("/:orgId/plan", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  if (!orgId) { sendError(res, 400, "orgId is required"); return; }
  // Authorize before validating the body — don't reveal anything to a caller who
  // isn't an owner of this org.
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!can(role, "org:manage")) {
    sendError(res, 403, "This action requires the 'org:manage' capability");
    return;
  }
  const plan = req.body?.plan;
  if (!isOrgPlan(plan)) {
    sendError(res, 400, `plan must be one of: ${ORG_PLANS.join(", ")}`);
    return;
  }
  try {
    const org = await memoryEngine.tenancy.updateOrganizationPlan(orgId, plan);
    res.json({ org: { orgId: org.orgId, name: org.name, slug: org.slug, plan: org.plan, role, capabilities: capabilitiesFor(role) } });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to update plan");
  }
});
