/**
 * Per-ORG recall-quality settings (dashboard → Intelligence → Advanced).
 *
 * A small, safe subset of the recall pipeline's `BRAINROUTER_RECALL_*` env knobs,
 * made configurable per organization and stored in the system-settings KV
 * (`recallSettings:${orgId}`) — same pattern as agent-models. Every field is
 * optional; an unset field falls back to the env/default at recall time. Admin
 * only (RBAC providers:manage). See memory/recall/orgRecallSettings.ts.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { RECALL_SETTING_FIELDS, normalizeRecallSettings, type RecallSettings } from "../../../memory/recall/orgRecallSettings.js";

export const recallSettingsRouter = Router();
recallSettingsRouter.use(requireAnyAuth, requirePermission("providers:manage"));

const settingsKey = (orgId: string) => `recallSettings:${orgId}`;

/** GET /api/admin/recall-settings — the tunable fields (with defaults) + the org's saved values. */
recallSettingsRouter.get("/", async (req: AuthedRequest, res) => {
  const stored = (await memoryEngine.emailAuth.getSetting<RecallSettings>(settingsKey(req.orgId!))) ?? {};
  res.json({ fields: RECALL_SETTING_FIELDS, settings: normalizeRecallSettings(stored) });
});

/** PUT /api/admin/recall-settings — replace the org's recall settings (validated + clamped). */
recallSettingsRouter.put("/", async (req: AuthedRequest, res) => {
  const body = req.body?.settings;
  if (body === undefined || body === null || typeof body !== "object") {
    sendError(res, 400, "a `settings` object is required");
    return;
  }
  const clean = normalizeRecallSettings(body);
  await memoryEngine.emailAuth.setSetting(settingsKey(req.orgId!), clean);
  memoryEngine.invalidateRecallOverrides(req.orgId!); // take effect immediately (skip the ~60s cache)
  res.json({ fields: RECALL_SETTING_FIELDS, settings: clean });
});
