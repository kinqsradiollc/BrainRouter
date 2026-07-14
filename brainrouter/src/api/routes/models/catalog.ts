import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { toModelCatalog } from "../../../providers/modelPolicyStore.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/tenancy.js";

export const modelsRouter = Router();
modelsRouter.use(requireAnyAuth, requirePermission("models:read"));

/** GET /api/models/catalog — enabled, member-safe organization model policy. */
modelsRouter.get("/catalog", async (req: AuthedRequest, res) => {
  const records = await memoryEngine.models.listProviderModels(req.orgId!, true);
  const catalog = toModelCatalog(records);
  const etag = `"${catalog.revision}"`;
  res.set({ ETag: etag, "Cache-Control": "private, no-cache" });
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.json(catalog);
});
