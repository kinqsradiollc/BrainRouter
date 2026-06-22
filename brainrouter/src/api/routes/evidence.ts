import { Router } from "express";
import { memoryEngine } from "../../memory/engine.js";
import { requireAnyAuth, scopedUserId, errorStatus, type AuthedRequest } from "../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../pagination.js";
import { sendError } from "../../contracts/http.js";

export const evidenceRouter = Router();
evidenceRouter.use(requireAnyAuth);

const scopeEvidence = (req: AuthedRequest, requested?: unknown) => scopedUserId(req, requested, "evidence");

/**
 * GET /api/evidence
 * Returns all evidence rows for the authenticated user.
 * Optional query params:
 *   - recordId: filter by parent memory record
 *   - kind: filter by evidence kind (file, command, url, test, benchmark, memory, other)
 *   - limit: max results (default 20, max 100)
 *   - cursor: pagination cursor
 */
evidenceRouter.get("/", async (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const userId = scopeEvidence(req, req.query.userId);
    const filters = {
      recordId: typeof req.query.recordId === "string" && req.query.recordId.trim() ? req.query.recordId.trim() : undefined,
      kind: typeof req.query.kind === "string" && req.query.kind !== "all" ? req.query.kind : undefined,
    };
    const evidence = memoryEngine.listEvidence(userId, filters, {
      cursor: decodeCursor<{ observedAt: string; id: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    });
    const page = pageItems(evidence, pagination.limit, (ev) => ({
      observedAt: ev.observedAt,
      id: ev.id,
    }));
    res.json({ evidence: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    sendError(res, errorStatus(error, 400), error instanceof Error ? error.message : "Invalid evidence parameters");
  }
});

/**
 * GET /api/evidence/:recordId
 * Returns all evidence attached to a specific memory record.
 */
evidenceRouter.get("/:recordId", async (req: AuthedRequest, res) => {
  try {
    const recordId = String(req.params.recordId);
    const evidence = memoryEngine.getEvidence(req.userId!, recordId);
    res.json({ evidence, total: evidence.length });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : "Failed to fetch evidence");
  }
});
