/**
 * ADR-054 D3 — the priced per-automation usage view (dashboard → Providers →
 * Advanced, or a cost page). Reads the org's aggregate and prices it at the org's
 * CONTRACTED rate (ADR-052 P2b), so a runaway loop is identifiable by name AND by
 * cost at the org's real rates — ADR-052 §5.3. Admin only (RBAC providers:manage).
 */
import { Router } from "express";
import { loadModelsConfig } from "@kinqs/brainrouter-core/config";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { priceOrgUsage, type OrgUsageAggregate } from "../../../memory/usage/orgUsageAggregate.js";
import { normalizeOrgPricingSettings, type OrgPricingSettings } from "../../../memory/pricing/orgPricingSettings.js";

export const usageAutomationRouter = Router();
usageAutomationRouter.use(requireAnyAuth, requirePermission("providers:manage"));

/** GET /api/admin/usage-automation — per-automation totals priced at the org's contracted rate. */
usageAutomationRouter.get("/", async (req: AuthedRequest, res) => {
  const aggregate = (await memoryEngine.emailAuth.getSetting<OrgUsageAggregate>(`usageAutomation:${req.orgId!}`)) ?? {};
  const pricing = normalizeOrgPricingSettings((await memoryEngine.emailAuth.getSetting<OrgPricingSettings>(`pricingSettings:${req.orgId!}`)) ?? {});
  const models = loadModelsConfig().models;
  const listRateFor = (model: string): { inputPerMTok: number; outputPerMTok: number } => {
    const p = models[model]?.pricing;
    return { inputPerMTok: p?.inputCacheMiss ?? 0, outputPerMTok: p?.output ?? 0 };
  };
  res.json({ automations: priceOrgUsage(aggregate, pricing, listRateFor) });
});
