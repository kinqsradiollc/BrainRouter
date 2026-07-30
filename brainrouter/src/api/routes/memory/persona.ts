import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";
import { planHasFeature } from "../../../tenancy/entitlements.js";

export const personaRouter = Router();
personaRouter.use(requireAnyAuth);

personaRouter.get("/", async (req: AuthedRequest, res) => {
  const persona = await memoryEngine.getPersona(req.userId!);
  res.json({ persona });
});

/**
 * GET /api/persona/org/:orgId — the Team consensus persona (ADR-014 P-C). Caller
 * must be a member; the team plan must include the `orgPersona` feature. Distils
 * on-demand; `null` persona = no shared persona/instruction memories yet.
 */
personaRouter.get("/org/:orgId", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!role) { sendError(res, 403, "You are not a member of that team"); return; }
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org || !planHasFeature(org.plan, "orgPersona")) {
    sendError(res, 402, "A team consensus persona requires the team plan or higher."); return;
  }
  const persona = await memoryEngine.getOrgPersona(orgId);
  res.json({ persona });
});

/** POST /api/persona/org/:orgId/refresh — force re-distillation (members:manage). */
personaRouter.post("/org/:orgId/refresh", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!role) { sendError(res, 403, "You are not a member of that team"); return; }
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org || !planHasFeature(org.plan, "orgPersona")) {
    sendError(res, 402, "A team consensus persona requires the team plan or higher."); return;
  }
  const result = await memoryEngine.distillOrgPersona(orgId);
  res.json({ ok: result.success, persona: result.success ? { personaMd: result.personaMd } : null });
});
