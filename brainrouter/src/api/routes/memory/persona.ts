import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";

export const personaRouter = Router();
personaRouter.use(requireAnyAuth);

personaRouter.get("/", async (req: AuthedRequest, res) => {
  const persona = await memoryEngine.getPersona(req.userId!);
  res.json({ persona });
});
