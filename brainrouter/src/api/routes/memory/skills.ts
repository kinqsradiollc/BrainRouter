import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { sendError } from "../../../contracts/http.js";

export const skillsRouter = Router();
skillsRouter.use(requireAnyAuth);

skillsRouter.get("/activations", async (req: AuthedRequest, res) => {
  try {
    const activations = await memoryEngine.getSkillActivations(req.userId!);
    res.json(activations);
  } catch (error: any) {
    sendError(res, 500, error.message);
  }
});
