import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { sendError } from "../../contracts/http.js";

export const graphRouter = Router();
graphRouter.use(requireAnyAuth);

graphRouter.get("/", async (req: AuthedRequest, res) => {
  const entity = typeof req.query.entity === "string" ? req.query.entity.trim() : "";
  if (!entity) {
    sendError(res, 400, "entity query param is required");
    return;
  }
  const hops = Number(req.query.hops ?? 2);
  const skillTag = typeof req.query.skillTag === "string" ? req.query.skillTag : undefined;
  const result = await memoryEngine.queryGraph(req.userId!, entity, skillTag, Number.isFinite(hops) ? hops : 2);
  res.json(result);
});

// DASH-1 / DASH-1b — graph analytics lenses (PageRank centrality, broker/bridge
// detection, namespace overview, optional shortest connection path). Powers the
// dashboard Intelligence view.
graphRouter.get("/analytics", async (req: AuthedRequest, res) => {
  try {
    const topN = Number(req.query.topN ?? 10);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const result = await memoryEngine.graphAnalytics(req.userId!, { topN: Number.isFinite(topN) ? topN : 10, from, to });
    res.json(result);
  } catch (err: any) {
    sendError(res, 500, err.message);
  }
});

graphRouter.get("/connections", async (req: AuthedRequest, res) => {
  try {
    const result = await memoryEngine.store.getAllConnections(req.userId!);
    res.json(result);
  } catch (err: any) {
    sendError(res, 500, err.message);
  }
});
