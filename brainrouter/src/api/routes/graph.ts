import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const graphRouter = Router();
graphRouter.use(requireAnyAuth);

graphRouter.get("/", (req: AuthedRequest, res) => {
  const entity = typeof req.query.entity === "string" ? req.query.entity.trim() : "";
  if (!entity) {
    res.status(400).json({ error: "entity query param is required" });
    return;
  }
  const hops = Number(req.query.hops ?? 2);
  const skillTag = typeof req.query.skillTag === "string" ? req.query.skillTag : undefined;
  const result = memoryEngine.queryGraph(req.userId!, entity, skillTag, Number.isFinite(hops) ? hops : 2);
  res.json(result);
});

// DASH-1 / DASH-1b — graph analytics lenses (PageRank centrality, broker/bridge
// detection, namespace overview, optional shortest connection path). Powers the
// dashboard Intelligence view.
graphRouter.get("/analytics", (req: AuthedRequest, res) => {
  try {
    const topN = Number(req.query.topN ?? 10);
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const result = memoryEngine.graphAnalytics(req.userId!, { topN: Number.isFinite(topN) ? topN : 10, from, to });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

graphRouter.get("/connections", (req: AuthedRequest, res) => {
  try {
    const result = memoryEngine.store.getAllConnections(req.userId!);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
