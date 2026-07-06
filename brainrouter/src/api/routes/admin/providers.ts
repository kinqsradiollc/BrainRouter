/**
 * Admin provider-config API (ADR-010 P2/P3) — DB-backed AI providers, the same
 * setup the desktop/CLI use, gated by RBAC: only owner/admin (providers:manage)
 * may read or write. Every route acts on the caller's active org (req.orgId,
 * attached by requirePermission). API keys go in as plaintext and are sealed at
 * rest; they are NEVER returned.
 */
import { Router, type Response } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";
import { sendError } from "../../../contracts/http.js";
import { isProviderKind, PROVIDER_KINDS, type ProviderConfigInput } from "../../../providers/types.js";
import { isSecretBoxConfigured } from "../../../security/secretBox.js";

export const providersRouter = Router();
providersRouter.use(requireAnyAuth, requirePermission("providers:manage"));

/** Parse a create/update body into ProviderConfigInput (kind required on create). */
function parseInput(body: any, requireKind: boolean): ProviderConfigInput | { error: string } {
  const kind = String(body?.kind ?? "").trim();
  if (requireKind && !isProviderKind(kind)) return { error: `kind must be one of ${PROVIDER_KINDS.join(", ")}` };
  const out: ProviderConfigInput = { kind: (isProviderKind(kind) ? kind : "llm") };
  const str = (k: string) => (typeof body?.[k] === "string" ? body[k] : undefined);
  if (str("providerId") !== undefined) out.providerId = str("providerId");
  if (str("label") !== undefined) out.label = str("label");
  if (str("baseUrl") !== undefined) out.baseUrl = str("baseUrl");
  if (str("apiKey") !== undefined) out.apiKey = str("apiKey");
  if (str("model") !== undefined) out.model = str("model");
  if (Array.isArray(body?.models)) out.models = body.models.filter((m: unknown): m is string => typeof m === "string");
  if (str("wireFormat") !== undefined) out.wireFormat = str("wireFormat");
  if (str("reasoningEffort") !== undefined) out.reasoningEffort = str("reasoningEffort");
  if (body?.extra && typeof body.extra === "object") out.extra = body.extra;
  if (typeof body?.enabled === "boolean") out.enabled = body.enabled;
  if (typeof body?.isDefault === "boolean") out.isDefault = body.isDefault;
  return out;
}

/** GET /api/admin/providers — the org's configs (no keys). */
providersRouter.get("/", async (req: AuthedRequest, res) => {
  const configs = await memoryEngine.providers.listProviderConfigs(req.orgId!);
  res.json({ providers: configs, secretStorageReady: isSecretBoxConfigured() });
});

/** POST /api/admin/providers — create a config. */
providersRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = parseInput(req.body, true);
  if ("error" in parsed) { sendError(res, 400, parsed.error); return; }
  if (parsed.apiKey && !isSecretBoxConfigured()) {
    sendError(res, 400, "BRAINROUTER_SECRET_KEY must be configured before storing a provider API key");
    return;
  }
  try {
    const created = await memoryEngine.providers.createProviderConfig(req.orgId!, parsed, req.userId);
    res.status(201).json({ provider: created });
  } catch (error: any) {
    sendError(res, 400, error?.message ?? "Failed to create provider config");
  }
});

/** Load a config and assert it belongs to the caller's org. */
async function ownedConfig(req: AuthedRequest, res: Response) {
  const cfg = await memoryEngine.providers.getProviderConfig(String(req.params.id));
  if (!cfg || cfg.orgId !== req.orgId) {
    sendError(res, 404, "Provider config not found");
    return null;
  }
  return cfg;
}

/** PATCH /api/admin/providers/:id — update fields (omit apiKey to keep the key). */
providersRouter.patch("/:id", async (req: AuthedRequest, res) => {
  if (!(await ownedConfig(req, res))) return;
  const parsed = parseInput(req.body, false);
  if ("error" in parsed) { sendError(res, 400, parsed.error); return; }
  if (parsed.apiKey && !isSecretBoxConfigured()) {
    sendError(res, 400, "BRAINROUTER_SECRET_KEY must be configured before storing a provider API key");
    return;
  }
  const updated = await memoryEngine.providers.updateProviderConfig(String(req.params.id), parsed);
  res.json({ provider: updated });
});

/** DELETE /api/admin/providers/:id */
providersRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await ownedConfig(req, res))) return;
  await memoryEngine.providers.deleteProviderConfig(String(req.params.id));
  res.json({ ok: true });
});

/** POST /api/admin/providers/:id/default — make this the default for its kind. */
providersRouter.post("/:id/default", async (req: AuthedRequest, res) => {
  const cfg = await ownedConfig(req, res);
  if (!cfg) return;
  await memoryEngine.providers.setDefaultProvider(req.orgId!, cfg.kind, cfg.id);
  res.json({ ok: true });
});
