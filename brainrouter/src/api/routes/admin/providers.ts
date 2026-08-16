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
import { probeModels, deriveProviderId, probeEmbeddingDim } from "../../../providers/modelProbe.js";
import { isSystemProviderOrg, systemProviderOrgId } from "../../../providers/runtime.js";
import { BUILTIN_PROVIDERS, providerServesKind } from "@kinqs/brainrouter-core/provider";
import { upstreamProbePolicy } from "../../../providers/upstreamProbePolicy.js";

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

/**
 * GET /api/admin/providers/catalog?kind=llm|embedding|reranker — the providers the
 * shared core (desktop/CLI) supports FOR THAT KIND. Reused verbatim (no new provider
 * code): chat providers for llm, and the embedding/reranker vendors (Cohere, Voyage,
 * Jina, + the OpenAI-compatible/local ones) for those kinds, via core's capability tags.
 */
providersRouter.get("/catalog", (req: AuthedRequest, res) => {
  const kindParam = String(req.query.kind ?? "").trim().toLowerCase();
  const cap: "chat" | "embedding" | "reranker" = kindParam === "embedding" ? "embedding" : kindParam === "reranker" ? "reranker" : "chat";
  const providers = (BUILTIN_PROVIDERS as any[])
    .filter((p) => p && providerServesKind(p, cap))
    .map((p) => ({
      id: String(p.id),
      label: String(p.label ?? p.id),
      endpoint: typeof p.endpoint === "string" ? p.endpoint : "",
      local: Boolean(p.local),
      requestFormat: typeof p.requestFormat === "string" ? p.requestFormat : undefined,
      capabilities: Array.isArray(p.capabilities) ? p.capabilities : ["chat"],
      defaultModels: Array.isArray(p.defaultModels) ? p.defaultModels : [],
    }));
  res.json({ providers });
});

/**
 * GET /api/admin/providers — the org's configs (no keys).
 *
 * BYOK providers are intentionally per-org (ADR-010/ADR-012 — data, not env),
 * but an org with none of its own is shown the system/deployment org's configs
 * READ-ONLY (flagged `inherited`), so switching org/team surfaces the
 * deployment default that backs the inherited managed models instead of a blank
 * page. Read-only display only: mutations still resolve through ownedConfig(),
 * which 404s the system-org ids, and never trigger applyProviderOverrides.
 */
providersRouter.get("/", async (req: AuthedRequest, res) => {
  const orgId = req.orgId!;
  const own = await memoryEngine.providers.listProviderConfigs(orgId);
  if (own.length === 0 && !isSystemProviderOrg(orgId)) {
    const systemOrg = systemProviderOrgId();
    const inherited = await memoryEngine.providers.listProviderConfigs(systemOrg);
    if (inherited.length > 0) {
      res.json({
        providers: inherited.map((cfg) => ({ ...cfg, readOnly: true })),
        secretStorageReady: isSecretBoxConfigured(),
        inherited: true,
        source: { orgId: systemOrg, isSystemOrg: false },
      });
      return;
    }
  }
  res.json({
    providers: own,
    secretStorageReady: isSecretBoxConfigured(),
    inherited: false,
    source: { orgId, isSystemOrg: isSystemProviderOrg(orgId) },
  });
});

/**
 * POST /api/admin/providers/probe-models — discover the models an endpoint exposes
 * (GET /models, or LM Studio's native /api/v1/models). Reuses @kinqs/brainrouter-core
 * so the dashboard can offer the same "Fetch models" flow as the desktop.
 */
providersRouter.post("/probe-models", async (req: AuthedRequest, res) => {
  const baseUrl = String(req.body?.baseUrl ?? "").trim();
  const apiKey = String(req.body?.apiKey ?? "").trim();
  const kind = String(req.body?.kind ?? "llm").trim();
  if (!baseUrl) { sendError(res, 400, "baseUrl is required"); return; }
  try {
    const models = await probeModels(baseUrl, apiKey, kind, 8000, upstreamProbePolicy());
    res.json({ ok: true, models });
  } catch (error) {
    // 200 with ok:false — a probe failure is a normal, recoverable UI state.
    res.json({ ok: false, error: error instanceof Error ? error.message : "Failed to fetch models" });
  }
});

/**
 * POST /api/admin/providers/probe-embedding-dim — test-embed the candidate model to
 * discover its output dimension, and report the store's CURRENT dimension. The
 * dashboard warns before a swap that changes the dimension (rebuilds cognitive_vec).
 */
providersRouter.post("/probe-embedding-dim", async (req: AuthedRequest, res) => {
  const baseUrl = String(req.body?.baseUrl ?? "").trim();
  const apiKey = String(req.body?.apiKey ?? "").trim();
  const model = String(req.body?.model ?? "").trim();
  if (!baseUrl || !model) { sendError(res, 400, "baseUrl and model are required"); return; }
  const dimensions = await probeEmbeddingDim(baseUrl, apiKey, model, 8000, upstreamProbePolicy());
  res.json({ ok: dimensions != null, dimensions, currentDimensions: memoryEngine.getEmbeddingDimensions() });
});

/** POST /api/admin/providers — create a config. */
providersRouter.post("/", async (req: AuthedRequest, res) => {
  const parsed = parseInput(req.body, true);
  if ("error" in parsed) { sendError(res, 400, parsed.error); return; }
  if (parsed.apiKey && !isSecretBoxConfigured()) {
    sendError(res, 400, "BRAINROUTER_SECRET_KEY must be configured before storing a provider API key");
    return;
  }
  // Derive the provider id from the endpoint (via core's catalog) or the label, so
  // the dashboard no longer needs a manual "Provider id" field (desktop parity).
  if (!parsed.providerId?.trim()) {
    parsed.providerId = await deriveProviderId(parsed.baseUrl, parsed.label);
  }
  try {
    const created = await memoryEngine.providers.createProviderConfig(req.orgId!, parsed, req.userId);
    await memoryEngine.applyProviderOverrides(); // take effect without a restart
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
  await memoryEngine.applyProviderOverrides();
  res.json({ provider: updated });
});

/** DELETE /api/admin/providers/:id */
providersRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await ownedConfig(req, res))) return;
  await memoryEngine.providers.deleteProviderConfig(String(req.params.id));
  await memoryEngine.applyProviderOverrides();
  res.json({ ok: true });
});

/** POST /api/admin/providers/:id/default — make this the default for its kind. */
providersRouter.post("/:id/default", async (req: AuthedRequest, res) => {
  const cfg = await ownedConfig(req, res);
  if (!cfg) return;
  await memoryEngine.providers.setDefaultProvider(req.orgId!, cfg.kind, cfg.id);
  res.json({ ok: true });
});
