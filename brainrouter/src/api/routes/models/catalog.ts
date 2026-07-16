import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { toModelCatalog } from "../../../providers/modelPolicyStore.js";
import { systemProviderOrgId } from "../../../providers/runtime.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";

export const modelsRouter = Router();
modelsRouter.use(requireAnyAuth, requirePermission("models:read"));

/** GET /api/models/catalog — enabled, member-safe organization model policy.
 * An org with no managed models of its own inherits the deployment default (the
 * system org's models), so every org's chat/model picker works off one
 * deployment-configured set — mirrors the gateway's resolveScopedModelSelection. */
modelsRouter.get("/catalog", async (req: AuthedRequest, res) => {
  let records = await memoryEngine.models.listProviderModels(req.orgId!, true);
  if (records.length === 0) {
    const fallbackOrgId = systemProviderOrgId();
    if (fallbackOrgId && fallbackOrgId !== req.orgId) {
      records = await memoryEngine.models.listProviderModels(fallbackOrgId, true);
    }
  }
  const catalog = toModelCatalog(records);
  const etag = `"${catalog.revision}"`;
  res.set({ ETag: etag, "Cache-Control": "private, no-cache" });
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.json(catalog);
});
