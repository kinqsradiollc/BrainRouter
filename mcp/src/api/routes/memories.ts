import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const memoriesRouter = Router();
memoriesRouter.use(requireAnyAuth);

memoriesRouter.get("/", (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const archived = req.query.archived;
    const filters = {
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      scene: typeof req.query.scene === "string" ? req.query.scene : undefined,
      skill: typeof req.query.skill === "string" ? req.query.skill : undefined,
      archived: typeof archived === "string" ? archived === "true" : undefined,
    };
    const memories = memoryEngine.listMemories(req.userId!, filters, {
      cursor: decodeCursor<{ createdTime: string; recordId: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    });
    const page = pageItems(memories, pagination.limit, (memory) => ({
      createdTime: memory.createdTime,
      recordId: memory.recordId,
    }));
    res.json({ memories: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid pagination parameters" });
  }
});

memoriesRouter.delete("/:id", (req: AuthedRequest, res) => {
  memoryEngine.deleteMemory(req.userId!, String(req.params.id));
  res.json({ success: true });
});
