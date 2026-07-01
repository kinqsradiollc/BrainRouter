import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const statsRouter = Router();
statsRouter.use(requireAnyAuth);

statsRouter.get("/", async (req: AuthedRequest, res) => {
  res.json(await memoryEngine.getStats(req.userId!));
});
