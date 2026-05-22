import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const statsRouter = Router();
statsRouter.use(requireAnyAuth);

statsRouter.get("/", (req: AuthedRequest, res) => {
  res.json(memoryEngine.getStats(req.userId!));
});
