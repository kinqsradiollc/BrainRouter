import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";
import { validate } from "../middleware/validate.js";
import { z } from "zod";
import { sendError } from "../../contracts/http.js";

export const contradictionsRouter = Router();
contradictionsRouter.use(requireAnyAuth);

const CONTRADICTION_STATUS_FILTERS = ["pending", "resolved", "dismissed", "all"] as const;

contradictionsRouter.get("/", async (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const statusFilter = CONTRADICTION_STATUS_FILTERS.includes(req.query.status as never)
      ? (req.query.status as (typeof CONTRADICTION_STATUS_FILTERS)[number])
      : "pending";
    const contradictions = await memoryEngine.getPendingContradictions(req.userId!, {
      cursor: decodeCursor<{ confidence: number; id: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    }, statusFilter);
    const page = pageItems(contradictions, pagination.limit, (contradiction) => ({
      confidence: contradiction.confidence,
      id: contradiction.id,
    }));
    res.json({ contradictions: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Invalid pagination parameters");
  }
});

contradictionsRouter.post(
  "/:id/resolve",
  validate({
    params: z.object({ id: z.string().min(1) }),
    body: z.object({ status: z.enum(["resolved", "dismissed"]).optional() }),
  }),
  async (req: AuthedRequest, res) => {
    const status = req.body?.status === "dismissed" ? "dismissed" : "resolved";
    await memoryEngine.resolveContradiction(String(req.params.id), req.userId!, status);
    res.json({ success: true });
  },
);
