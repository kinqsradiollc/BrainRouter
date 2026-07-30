import { Router } from "express";
import { memoryEngine } from "../../../memory/engine.js";
import { requireAnyAuth, type AuthedRequest } from "../../middleware/auth.js";
import { decodeCursor, pageItems, PaginationQuerySchema } from "../../pagination.js";
import { z } from "zod";
import { sendError } from "../../../contracts/http.js";
import { can } from "../../../tenancy/rbac.js";
import { planHasFeature } from "../../../tenancy/entitlements.js";

export const memoriesRouter = Router();
memoriesRouter.use(requireAnyAuth);

// ── artifact sharing (ADR-014 Phase D) — mounted before "/:recordId" so the
//    literal paths aren't captured as a recordId. ─────────────────────────────

/** GET /api/memories/org/:orgId/shared — the Team's shared pool (member-only). */
memoriesRouter.get("/org/:orgId/shared", async (req: AuthedRequest, res) => {
  const orgId = String(req.params.orgId ?? "").trim();
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!role) { sendError(res, 403, "You are not a member of that team"); return; }
  const limit = Math.min(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const items = await memoryEngine.sharing.listOrgSharedMemories(orgId, limit);
  res.json({ shared: items });
});

/** POST /api/memories/:recordId/share { orgId } — share your record with a Team. */
memoriesRouter.post("/:recordId/share", async (req: AuthedRequest, res) => {
  const orgId = String(req.body?.orgId ?? "").trim();
  if (!orgId) { sendError(res, 400, "orgId is required"); return; }
  const role = await memoryEngine.tenancy.getMemberRole(orgId, req.userId!);
  if (!can(role, "memory:share")) { sendError(res, 403, "This action requires the 'memory:share' capability"); return; }
  const org = await memoryEngine.tenancy.getOrganization(orgId);
  if (!org || !planHasFeature(org.plan, "sharedMemory")) {
    sendError(res, 402, "Shared team memory requires the team plan or higher."); return;
  }
  const ok = await memoryEngine.sharing.setMemoryVisibility(String(req.params.recordId), req.userId!, orgId, "org");
  if (!ok) { sendError(res, 404, "Memory not found (or not yours to share)"); return; }
  res.json({ ok: true, visibility: "org", orgId });
});

/** POST /api/memories/:recordId/unshare — make your record private again. */
memoriesRouter.post("/:recordId/unshare", async (req: AuthedRequest, res) => {
  const orgId = String(req.body?.orgId ?? "").trim();
  const ok = await memoryEngine.sharing.setMemoryVisibility(String(req.params.recordId), req.userId!, orgId, "private");
  if (!ok) { sendError(res, 404, "Memory not found (or not yours)"); return; }
  res.json({ ok: true, visibility: "private" });
});

memoriesRouter.get("/", async (req: AuthedRequest, res) => {
  try {
    const pagination = PaginationQuerySchema.parse(req.query);
    const archived = req.query.archived;
    const filters = {
      query: typeof req.query.query === "string" ? req.query.query : undefined,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      scene: typeof req.query.scene === "string" ? req.query.scene : undefined,
      skill: typeof req.query.skill === "string" ? req.query.skill : undefined,
      archived: typeof archived === "string" ? archived === "true" : undefined,
    };
    const memories = await memoryEngine.listMemories(req.userId!, filters, {
      cursor: decodeCursor<{ createdTime: string; recordId: string }>(pagination.cursor),
      limit: pagination.limit + 1,
    });
    const page = pageItems(memories, pagination.limit, (memory) => ({
      createdTime: memory.createdTime,
      recordId: memory.recordId,
    }));
    res.json({ memories: page.items, nextCursor: page.nextCursor, limit: pagination.limit, hasMore: Boolean(page.nextCursor) });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Invalid pagination parameters");
  }
});

memoriesRouter.get("/:recordId", async (req: AuthedRequest, res) => {
  const result = await memoryEngine.getMemoryById(req.userId!, String(req.params.recordId));
  if (!result) {
    sendError(res, 404, "Memory not found");
    return;
  }
  res.json(result);
});

memoriesRouter.patch("/:recordId", async (req: AuthedRequest, res) => {
  try {
    const body = z.object({
      content: z.string().optional(),
      status: z.enum(["active", "superseded", "archived", "needs_verification"]).optional(),
      confidence: z.number().min(0).max(1).optional(),
      verificationStatus: z.enum(["", "verified", "unverified", "stale"]).optional(),
      note: z.string().optional(),
    }).parse(req.body ?? {});
    if (body.content && body.content.length > 10000) {
      sendError(res, 400, "Content too long");
      return;
    }
    const result = await memoryEngine.updateMemory(req.userId!, String(req.params.recordId), body);
    if (!result) {
      sendError(res, 404, "Memory not found");
      return;
    }
    res.json(result);
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Invalid request body");
  }
});

memoriesRouter.post("/:recordId/evidence", async (req: AuthedRequest, res) => {
  try {
    const body = z.object({
      kind: z.enum(["file", "command", "url", "test", "benchmark", "memory", "other"]),
      ref: z.string().min(1),
      excerpt: z.string().optional().default(""),
      metadata: z.record(z.unknown()).optional().default({}),
    }).parse(req.body ?? {});
    const evidence = await memoryEngine.addEvidence(req.userId!, String(req.params.recordId), body);
    res.status(201).json({ evidence });
  } catch (error) {
    sendError(res, 400, error instanceof Error ? error.message : "Invalid request body");
  }
});

memoriesRouter.get("/:recordId/evidence", async (req: AuthedRequest, res) => {
  res.json({ evidence: await memoryEngine.getEvidence(req.userId!, String(req.params.recordId)) });
});

memoriesRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  if (reason) {
    await memoryEngine.governanceDelete(req.userId!, String(req.params.id), reason);
  } else {
    await memoryEngine.deleteMemory(req.userId!, String(req.params.id));
  }
  res.json({ success: true });
});
