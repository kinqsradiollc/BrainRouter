/**
 * ADR-052 P2b — per-ORG contracted pricing (dashboard → Providers → Advanced).
 *
 * A global discount multiplier + explicit per-model rates, stored in the
 * system-settings KV (`pricingSettings:${orgId}`) — the same pattern as
 * recall-settings. Cost surfaces read it so an org sees its contracted numbers
 * instead of list price. Admin only (RBAC providers:manage).
 * See memory/pricing/orgPricingSettings.ts.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { PRICING_SETTING_FIELDS, normalizeOrgPricingSettings, type OrgPricingSettings } from "../../../memory/pricing/orgPricingSettings.js";

export const pricingSettingsRouter = Router();
pricingSettingsRouter.use(requireAnyAuth, requirePermission("providers:manage"));

const settingsKey = (orgId: string) => `pricingSettings:${orgId}`;

/** GET /api/admin/pricing-settings — the tunable fields + the org's saved values. */
pricingSettingsRouter.get("/", async (req: AuthedRequest, res) => {
  const stored = (await memoryEngine.emailAuth.getSetting<OrgPricingSettings>(settingsKey(req.orgId!))) ?? {};
  res.json({ fields: PRICING_SETTING_FIELDS, settings: normalizeOrgPricingSettings(stored) });
});

/** PUT /api/admin/pricing-settings — replace the org's pricing settings (validated + clamped). */
pricingSettingsRouter.put("/", async (req: AuthedRequest, res) => {
  const body = req.body?.settings;
  if (body === undefined || body === null || typeof body !== "object") {
    sendError(res, 400, "a `settings` object is required");
    return;
  }
  const clean = normalizeOrgPricingSettings(body);
  await memoryEngine.emailAuth.setSetting(settingsKey(req.orgId!), clean);
  res.json({ fields: PRICING_SETTING_FIELDS, settings: clean });
});
