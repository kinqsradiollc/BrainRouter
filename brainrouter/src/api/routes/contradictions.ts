import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const contradictionsRouter = Router();
contradictionsRouter.use(requireAnyAuth);

contradictionsRouter.get("/", (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const contradictions = memoryEngine.getPendingContradictions(req.userId!, {
      cursor: decodeCursor<{ confidence: number; id: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    });
    const page = pageItems(contradictions, pagination.limit, (contradiction) => ({
      confidence: contradiction.confidence,
      id: contradiction.id,
    }));
    res.json({ contradictions: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid pagination parameters" });
  }
});

contradictionsRouter.post("/:id/resolve", (req: AuthedRequest, res) => {
  const status = req.body?.status === "dismissed" ? "dismissed" : "resolved";
  memoryEngine.resolveContradiction(String(req.params.id), req.userId!, status);
  res.json({ success: true });
});
