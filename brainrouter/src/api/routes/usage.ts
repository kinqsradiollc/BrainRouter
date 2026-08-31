/**
 * ADR-054 D2 — the per-automation usage ingest. A client (agent/CLI meter) POSTs
 * its per-automation token delta on flush; the server folds it into the org's
 * bounded aggregate (`usageAutomation:${orgId}`). Authed but not admin — a client
 * reports its OWN org's usage. Best-effort by contract: a failed push never
 * affects a turn, so this route just merges + acks.
 */
import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendError } from "../../contracts/http.js";
import { mergeOrgUsage, type OrgUsageAggregate, type UsageDelta } from "../../memory/usage/orgUsageAggregate.js";

export const usageRouter = Router();
usageRouter.use(requireAnyAuth);

const key = (orgId: string) => `usageAutomation:${orgId}`;

/** POST /api/usage/automation — fold a per-automation token delta into the org aggregate. */
usageRouter.post("/automation", async (req: AuthedRequest, res) => {
  const delta = req.body?.delta as UsageDelta | undefined;
  if (!delta || typeof delta !== "object" || typeof delta.automation !== "string") {
    sendError(res, 400, "a `delta` with an `automation` id is required");
    return;
  }
  const existing = (await memoryEngine.emailAuth.getSetting<OrgUsageAggregate>(key(req.orgId!))) ?? {};
  const merged = mergeOrgUsage(existing, delta);
  await memoryEngine.emailAuth.setSetting(key(req.orgId!), merged);
  res.json({ ok: true });
});
