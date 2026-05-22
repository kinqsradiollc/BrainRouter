import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";

export const governanceRouter = Router();
governanceRouter.use(requireAnyAuth);

function scopedUserId(req: AuthedRequest, requested?: unknown): string {
  const requestedUserId = typeof requested === "string" && requested.trim() ? requested.trim() : undefined;
  if (!requestedUserId || requestedUserId === req.userId) return req.userId!;
  if (req.isAdmin) return requestedUserId;
  throw new Error("Cannot access another user's memory operations");
}

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

governanceRouter.get("/governance/diagnostics", (req: AuthedRequest, res) => {
  try {
    res.json(memoryEngine.getDiagnostics(scopedUserId(req, req.query.userId)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid diagnostics parameters" });
  }
});

// GET /api/operations — Timeline feed (all operation types, paginated)
governanceRouter.get("/operations", (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const userId = scopedUserId(req, req.query.userId);
    const filters = {
      operation: typeof req.query.operation === "string" && req.query.operation !== "all" ? req.query.operation : undefined,
      sessionKey: typeof req.query.sessionKey === "string" && req.query.sessionKey.trim() ? req.query.sessionKey.trim() : undefined,
      createdAfter: typeof req.query.createdAfter === "string" && req.query.createdAfter ? req.query.createdAfter : undefined,
      createdBefore: typeof req.query.createdBefore === "string" && req.query.createdBefore ? req.query.createdBefore : undefined,
    };
    const operations = memoryEngine.getOperationLog(userId, {
      cursor: decodeCursor<{ createdAt: string; id: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    }, filters);
    const page = pageItems(operations, pagination.limit, (op) => ({
      createdAt: op.createdAt,
      id: op.id,
    }));
    res.json({ operations: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid parameters" });
  }
});

// POST /api/recall/explain — Recall Inspector
governanceRouter.post("/recall/explain", async (req: AuthedRequest, res) => {
  try {
    const { query, sessionKey, activeSkill, userId: requestedUserId } = req.body as {
      query?: string;
      sessionKey?: string;
      activeSkill?: string;
      userId?: string;
    };
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const result = await memoryEngine.explainRecall({
      userId: scopedUserId(req, requestedUserId),
      sessionKey: sessionKey ?? `inspector_${Date.now()}`,
      query: query.trim(),
      activeSkill,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Explain recall failed" });
  }
});
