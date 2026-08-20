/**
 * ADR-043 C7 (D2) — per-org consent for edge egress ("client-tunnel").
 *
 * An org admin opts their org into routing managed-model traffic through their
 * own enrolled devices. Stored in the system-settings KV under
 * `egress:clientTunnelOptIn:${orgId}` as `{ enabled: boolean }` — the EXACT shape
 * the provider-gateway reads (services/gateway/index.ts). Admin only (RBAC
 * providers:manage); same pattern as recall-settings / agent-models.
 *
 * The gateway also honours a global kill-switch (`egress:clientTunnelKill`) read
 * out-of-band; this per-org surface only manages the org's own opt-in.
 */
import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";

export interface EgressOptIn {
  enabled: boolean;
}

/** The gateway keys its per-org opt-in read on this exact string. */
export const egressOptInKey = (orgId: string): string => `egress:clientTunnelOptIn:${orgId}`;

/** Coerce an arbitrary body to the stored shape — only a boolean `enabled` survives. */
export function normalizeEgressOptIn(body: unknown): EgressOptIn {
  const enabled = (body as { enabled?: unknown } | null | undefined)?.enabled;
  return { enabled: enabled === true };
}

export const egressSettingsRouter = Router();
egressSettingsRouter.use(requireAnyAuth, requirePermission("providers:manage"));

/** GET /api/admin/egress-settings — the org's client-tunnel opt-in (default off). */
egressSettingsRouter.get("/", async (req: AuthedRequest, res) => {
  const stored = (await memoryEngine.emailAuth.getSetting<EgressOptIn>(egressOptInKey(req.orgId!))) ?? { enabled: false };
  res.json({ settings: normalizeEgressOptIn(stored) });
});

/** PUT /api/admin/egress-settings — set the org's client-tunnel opt-in. */
egressSettingsRouter.put("/", async (req: AuthedRequest, res) => {
  const body = req.body?.settings;
  if (body === undefined || body === null || typeof body !== "object") {
    sendError(res, 400, "a `settings` object is required");
    return;
  }
  const clean = normalizeEgressOptIn(body);
  await memoryEngine.emailAuth.setSetting(egressOptInKey(req.orgId!), clean);
  res.json({ settings: clean });
});
