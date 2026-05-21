import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const scenesRouter = Router();
scenesRouter.use(requireAnyAuth);

scenesRouter.get("/", (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const scenes = memoryEngine.getTopScenes(
      req.userId!,
      pagination.limit + 1,
      decodeCursor<{ heatScore: number; id: string }>(pagination.cursor),
    );
    const page = pageItems(scenes, pagination.limit, (scene) => ({
      heatScore: scene.heatScore,
      id: scene.id,
    }));
    res.json({ scenes: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid pagination parameters" });
  }
});

scenesRouter.delete("/:id", (req: AuthedRequest, res) => {
  try {
    const sceneId = req.params.id;
    if (!sceneId) {
      res.status(400).json({ error: "Scene ID required" });
      return;
    }
    const targetId = typeof sceneId === "string" ? sceneId : sceneId[0];
    memoryEngine.store.deleteContextualFocus(req.userId!, [targetId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete scene" });
  }
});
