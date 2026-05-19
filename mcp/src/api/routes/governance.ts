import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const governanceRouter = Router();
governanceRouter.use(requireAnyAuth);

governanceRouter.get("/export", (req: AuthedRequest, res) => {
  res.json(memoryEngine.exportMemories(req.userId!));
});

governanceRouter.post("/import", (req: AuthedRequest, res) => {
  try {
    res.json(memoryEngine.importMemories(req.userId!, req.body));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid import payload" });
  }
});

governanceRouter.get("/audit", (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const operations = memoryEngine.getOperationLog(req.userId!, {
      cursor: decodeCursor<{ createdAt: string; id: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    });
    const page = pageItems(operations, pagination.limit, (operation) => ({
      createdAt: operation.createdAt,
      id: operation.id,
    }));
    res.json({ operations: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid pagination parameters" });
  }
});
