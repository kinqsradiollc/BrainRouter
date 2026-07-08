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
import { can, capabilitiesFor, isRole, normalizeRole, ROLES } from "../../../tenancy/rbac.js";
import { isOrgPlan, ORG_PLANS } from "../../../tenancy/types.js";
import { entitlementsFor, featuresFor, withinLimit, planHasFeature } from "../../../tenancy/entitlements.js";
import { domainAllowed, normalizeDomains } from "../../../tenancy/emailDomain.js";
import { generateToken, hashToken, expiryFrom, notExpired } from "../../../tenancy/tokens.js";
import { sendInviteEmail } from "../../../services/email/emailFlows.js";

const INVITE_TTL_MS = 7 * 86400_000;

/** Serialize a plan's entitlements (limits + features) for the dashboard. */
function entitlementsView(plan: string) {
  const ents = entitlementsFor(plan);
  return { limits: ents.limits, features: featuresFor(plan) };
}

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
        entitlements: entitlementsView(m.org.plan),
        allowedDomains: m.org.allowedDomains,
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
    // Enterprise domain allowlist: reject an invite whose email domain isn't allowed.
    const org = await memoryEngine.tenancy.getOrganization(orgId);
    if (org && org.allowedDomains.length > 0 && !domainAllowed(email, org.allowedDomains)) {
      sendError(res, 403, `${email} is not in this team's allowed email domains (${org.allowedDomains.join(", ")}).`);
      return;
    }
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
  // Seat limit (ADR-014 Phase A): only NEW members consume a seat — an upsert that
  // just changes an existing member's role does not.
  const members = await memoryEngine.tenancy.listOrgMembers(orgId);
  const alreadyMember = members.some((m) => m.userId === userId);
  if (!alreadyMember) {
    const org = await memoryEngine.tenancy.getOrganization(orgId);
    if (!withinLimit(org?.plan, "seats", members.length)) {
      const seats = entitlementsFor(org?.plan).limits.seats;
      sendError(res, 402, `The ${org?.plan ?? "current"} plan allows ${seats} member${seats === 1 ? "" : "s"}. Upgrade the plan to add more.`);
      return;
    }
  }
  await memoryEngine.tenancy.addOrgMember(orgId, userId, role);
  await memoryEngine.adminConsole.logOrgAudit({ orgId, actorId: req.userId, action: alreadyMember ? "member.role" : "member.add", target: userId, detail: role, createdAt: new Date().toISOString() });
  res.status(201).json({ orgId, userId, role, email: email || undefined });
});

/** DELETE /api/orgs/:orgId/members/:userId — remove a member (members:manage). */
orgsRouter.delete("/:orgId/members/:userId", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const orgId = String(req.params.orgId);
  const userId = String(req.params.userId);
  await memoryEngine.tenancy.removeOrgMember(orgId, userId);
  await memoryEngine.adminConsole.logOrgAudit({ orgId, actorId: req.userId, action: "member.remove", target: userId, createdAt: new Date().toISOString() });
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
    await memoryEngine.adminConsole.logOrgAudit({ orgId, actorId: req.userId, action: "plan.change", target: plan, createdAt: new Date().toISOString() });
    res.json({ org: { orgId: org.orgId, name: org.name, slug: org.slug, plan: org.plan, role, capabilities: capabilitiesFor(role) } });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to update plan");
  }
});

/** GET /api/orgs/:orgId/audit — the Team's audit trail (members:manage). */
orgsRouter.get("/:orgId/audit", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const entries = await memoryEngine.adminConsole.listOrgAudit(String(req.params.orgId), 100);
  res.json({ audit: entries });
});

/**
 * POST /api/orgs/:orgId/allowed-domains — set the team's email-domain allowlist
 * (owner via org:manage; requires the enterprise `domainAllowlist` feature). Body:
 * { domains: string[] }. An empty list clears the restriction.
 */
orgsRouter.post("/:orgId/allowed-domains", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  if (!orgId) { sendError(res, 400, "orgId is required"); return; }
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!can(role, "org:manage")) {
    sendError(res, 403, "This action requires the 'org:manage' capability");
    return;
  }
  const raw = req.body?.domains;
  if (!Array.isArray(raw) || raw.some((d) => typeof d !== "string")) {
    sendError(res, 400, "domains must be an array of strings");
    return;
  }
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org) { sendError(res, 404, "organization not found"); return; }
  if (!planHasFeature(org.plan, "domainAllowlist")) {
    sendError(res, 402, "Email-domain allowlisting requires the enterprise plan.");
    return;
  }
  try {
    const updated = await memoryEngine.tenancy.updateAllowedDomains(orgId, normalizeDomains(raw));
    res.json({ org: { orgId: updated.orgId, allowedDomains: updated.allowedDomains } });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Failed to update allowed domains");
  }
});

// ── invitations (ADR-014 Phase B2) ────────────────────────────────────────

/**
 * POST /api/orgs/accept-invite { token } — the signed-in user accepts an emailed
 * invitation. Their account email must match the invite. (Top-level; declared
 * before the `/:orgId/*` routes so it isn't captured as an orgId.)
 */
orgsRouter.post("/accept-invite", async (req: AuthedRequest, res) => {
  const token = String(req.body?.token ?? "").trim();
  if (!token) { sendError(res, 400, "token is required"); return; }
  const hash = hashToken(token);
  const now = new Date().toISOString();
  const invite = await memoryEngine.emailAuth.getInviteByHash(hash);
  if (!invite || invite.acceptedAt || !notExpired(invite.expiresAt, now)) {
    sendError(res, 400, "This invitation is invalid, expired, or already used"); return;
  }
  const user = await memoryEngine.getUserById(req.userId!);
  if (!user) { sendError(res, 401, "not authenticated"); return; }
  if ((user.email ?? "").trim().toLowerCase() !== invite.email.toLowerCase()) {
    sendError(res, 403, `This invitation is for ${invite.email}. Sign in with that email to accept.`); return;
  }
  const members = await memoryEngine.tenancy.listOrgMembers(invite.orgId);
  const org = await memoryEngine.tenancy.getOrganization(invite.orgId);
  if (!members.some((m) => m.userId === user.userId) && !withinLimit(org?.plan, "seats", members.length)) {
    sendError(res, 402, `This team is at its seat limit for the ${org?.plan ?? "current"} plan.`); return;
  }
  const accepted = await memoryEngine.emailAuth.acceptInvite(hash, now);
  if (!accepted) { sendError(res, 400, "This invitation is invalid, expired, or already used"); return; }
  await memoryEngine.tenancy.addOrgMember(invite.orgId, user.userId, normalizeRole(invite.role) ?? "developer");
  res.json({ ok: true, orgId: invite.orgId, name: org?.name });
});

/** POST /api/orgs/:orgId/invites { email, role } — invite by email (members:manage + `invites` feature). */
orgsRouter.post("/:orgId/invites", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const orgId = String(req.params.orgId);
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const role = normalizeRole(String(req.body?.role ?? "developer").trim());
  if (!email) { sendError(res, 400, "email is required"); return; }
  if (!role) { sendError(res, 400, `a valid role (${ROLES.join(", ")}) is required`); return; }
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org) { sendError(res, 404, "organization not found"); return; }
  if (!planHasFeature(org.plan, "invites")) {
    sendError(res, 402, "Email invitations require the team plan or higher."); return;
  }
  if (org.allowedDomains.length > 0 && !domainAllowed(email, org.allowedDomains)) {
    sendError(res, 403, `${email} is not in this team's allowed email domains (${org.allowedDomains.join(", ")}).`); return;
  }
  const { raw, hash } = generateToken();
  const now = new Date().toISOString();
  const expiresAt = expiryFrom(now, INVITE_TTL_MS);
  await memoryEngine.emailAuth.createInvite({ tokenHash: hash, orgId, email, role, invitedBy: req.userId!, expiresAt, acceptedAt: null, createdAt: now });
  const sent = await sendInviteEmail(email, org.name, raw);
  // Return the link ONLY when SMTP is off, so a no-email deployment still works.
  res.status(201).json({ invite: { email, role, expiresAt }, delivered: sent.ok, link: sent.ok ? undefined : sent.link });
});

/** GET /api/orgs/:orgId/invites — pending invitations (members:manage). */
orgsRouter.get("/:orgId/invites", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  const invites = await memoryEngine.emailAuth.listInvites(String(req.params.orgId));
  res.json({ invites: invites.map((i) => ({ email: i.email, role: i.role, invitedBy: i.invitedBy, expiresAt: i.expiresAt, createdAt: i.createdAt, tokenHash: i.tokenHash })) });
});

/** DELETE /api/orgs/:orgId/invites/:hash — revoke a pending invitation (members:manage). */
orgsRouter.delete("/:orgId/invites/:hash", async (req: AuthedRequest, res) => {
  if (!(await requireMemberAdmin(req, res))) return;
  await memoryEngine.emailAuth.revokeInvite(String(req.params.hash));
  res.json({ ok: true });
});
