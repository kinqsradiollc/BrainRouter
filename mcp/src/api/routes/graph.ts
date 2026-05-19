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
