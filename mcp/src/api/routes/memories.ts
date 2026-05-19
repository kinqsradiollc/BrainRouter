import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";
import { z } from "zod";

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

memoriesRouter.get("/:recordId", (req: AuthedRequest, res) => {
  const result = memoryEngine.getMemoryById(req.userId!, String(req.params.recordId));
  if (!result) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(result);
});

memoriesRouter.patch("/:recordId", (req: AuthedRequest, res) => {
  try {
    const body = z.object({
      content: z.string().optional(),
      status: z.enum(["active", "superseded", "archived", "needs_verification"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      verificationStatus: z.enum(["", "verified", "unverified", "stale"]).optional(),
      note: z.string().optional(),
    }).parse(req.body ?? {});
    const result = memoryEngine.updateMemory(req.userId!, String(req.params.recordId), body);
    if (!result) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request body" });
  }
});

memoriesRouter.post("/:recordId/evidence", (req: AuthedRequest, res) => {
  try {
    const body = z.object({
      kind: z.enum(["file", "command", "url", "test", "benchmark", "memory", "other"]),
      ref: z.string().min(1),
      excerpt: z.string().optional().default(""),
      metadata: z.record(z.unknown()).optional().default({}),
    }).parse(req.body ?? {});
    const evidence = memoryEngine.addEvidence(req.userId!, String(req.params.recordId), body);
    res.status(201).json({ evidence });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request body" });
  }
});

memoriesRouter.get("/:recordId/evidence", (req: AuthedRequest, res) => {
  res.json({ evidence: memoryEngine.getEvidence(req.userId!, String(req.params.recordId)) });
});

memoriesRouter.delete("/:id", (req: AuthedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (reason) {
    memoryEngine.governanceDelete(req.userId!, String(req.params.id), reason);
  } else {
    memoryEngine.deleteMemory(req.userId!, String(req.params.id));
  }
  res.json({ success: true });
});
