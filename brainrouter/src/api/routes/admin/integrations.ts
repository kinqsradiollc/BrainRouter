/**
 * Admin integration-config API (ADR-010 P6) — the org's own GitHub App bot (and
 * future integrations), DB-backed + encrypted at rest. Gated by RBAC: only
 * owner/admin (triggers:manage) may read or write. Secrets go in as plaintext,
 * are sealed at rest, and are NEVER returned (hasSecret only). Acts on the
 * caller's active org (req.orgId).
 */
import { Router, type Response } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { isIntegrationKind, INTEGRATION_KINDS, type IntegrationConfigInput } from "../../../integrations/types.js";
import { isSecretBoxConfigured } from "../../../security/secretBox.js";

export const integrationsRouter = Router();
integrationsRouter.use(requireAnyAuth, requirePermission("triggers:manage"));

function parseInput(body: any, requireKind: boolean): IntegrationConfigInput | { error: string } {
  const kind = String(body?.kind ?? "").trim();
  if (requireKind && !isIntegrationKind(kind)) return { error: `kind must be one of ${INTEGRATION_KINDS.join(", ")}` };
  const out: IntegrationConfigInput = { kind: (isIntegrationKind(kind) ? kind : "github_app") };
  if (typeof body?.enabled === "boolean") out.enabled = body.enabled;
  if (body?.config && typeof body.config === "object") out.config = body.config;
  if (body?.secret && typeof body.secret === "object") {
    const secret: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.secret)) if (typeof v === "string" && v) secret[k] = v;
    out.secret = secret;
  }
  return out;
}

async function owned(req: AuthedRequest, res: Response) {
  const cfg = await memoryEngine.integrations.getIntegrationConfig(String(req.params.id));
  if (!cfg || cfg.orgId !== req.orgId) { sendError(res, 404, "Integration not found"); return null; }
  return cfg;
}

/** GET /api/admin/integrations — the org's integrations (no secrets). */
integrationsRouter.get("/", async (req: AuthedRequest, res) => {
  const integrations = await memoryEngine.integrations.listIntegrationConfigs(req.orgId!);
  res.json({ integrations, secretStorageReady: isSecretBoxConfigured() });
});

/** POST /api/admin/integrations — create (e.g. the org GitHub App). */
integrationsRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = parseInput(req.body, true);
  if ("error" in parsed) { sendError(res, 400, parsed.error); return; }
  if (parsed.secret && Object.keys(parsed.secret).length > 0 && !isSecretBoxConfigured()) {
    sendError(res, 400, "BRAINROUTER_SECRET_KEY must be configured before storing an integration secret");
    return;
  }
  try {
    const created = await memoryEngine.integrations.createIntegrationConfig(req.orgId!, parsed, req.userId);
    res.status(201).json({ integration: created });
  } catch (error: any) {
    sendError(res, 400, error?.message ?? "Failed to create integration");
  }
});

/** PATCH /api/admin/integrations/:id — update (omit secret to keep it). */
integrationsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  if (!(await owned(req, res))) return;
  const parsed = parseInput(req.body, false);
  if ("error" in parsed) { sendError(res, 400, parsed.error); return; }
  if (parsed.secret && Object.keys(parsed.secret).length > 0 && !isSecretBoxConfigured()) {
    sendError(res, 400, "BRAINROUTER_SECRET_KEY must be configured before storing an integration secret");
    return;
  }
  const updated = await memoryEngine.integrations.updateIntegrationConfig(String(req.params.id), parsed);
  res.json({ integration: updated });
});

/** DELETE /api/admin/integrations/:id */
integrationsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await owned(req, res))) return;
  await memoryEngine.integrations.deleteIntegrationConfig(String(req.params.id));
  res.json({ ok: true });
});
