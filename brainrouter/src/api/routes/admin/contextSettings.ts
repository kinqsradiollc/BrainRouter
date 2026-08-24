/**
 * ADR-045 M3 — per-ORG context-window cap (dashboard → Providers → Advanced).
 *
 * The org, acting as a provider to its members, caps the context window
 * BrainRouter advertises for every model. Stored in the system-settings KV
 * (`contextSettings:${orgId}`) — same pattern as recall-settings / agent-models.
 * The field is optional; unset means "no cap" and the gateway advertises each
 * model's own window. Admin only (RBAC providers:manage).
 * See services/gateway/orgContextSettings.ts.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import {
  CONTEXT_SETTING_FIELDS,
  normalizeContextSettings,
  type ContextCapSettings,
} from "../../../services/gateway/orgContextSettings.js";

export const contextSettingsRouter = Router();
contextSettingsRouter.use(requireAnyAuth, requirePermission("providers:manage"));

const settingsKey = (orgId: string) => `contextSettings:${orgId}`;

/** GET /api/admin/context-settings — the tunable fields (with bounds) + the org's saved cap. */
contextSettingsRouter.get("/", async (req: AuthedRequest, res) => {
  const stored = (await memoryEngine.emailAuth.getSetting<ContextCapSettings>(settingsKey(req.orgId!))) ?? {};
  res.json({ fields: CONTEXT_SETTING_FIELDS, settings: normalizeContextSettings(stored) });
});

/** PUT /api/admin/context-settings — replace the org's context cap (validated + clamped). */
contextSettingsRouter.put("/", async (req: AuthedRequest, res) => {
  const body = req.body?.settings;
  if (body === undefined || body === null || typeof body !== "object") {
    sendError(res, 400, "a `settings` object is required");
    return;
  }
  const clean = normalizeContextSettings(body);
  await memoryEngine.emailAuth.setSetting(settingsKey(req.orgId!), clean);
  res.json({ fields: CONTEXT_SETTING_FIELDS, settings: clean });
});
