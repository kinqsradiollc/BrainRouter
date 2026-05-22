import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";

export const skillsRouter = Router();
skillsRouter.use(requireAnyAuth);

skillsRouter.get("/activations", (req: AuthedRequest, res) => {
  try {
    const activations = memoryEngine.getSkillActivations(req.userId!);
    res.json(activations);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
