/**
 * Planner API — authenticated, per-USER sync for ADR-028 Part D (migration 051).
 *
 * Every route is keyed by `(orgId, userId)` from the authenticated session, and
 * never by anything the caller sends. A planner is personal, so a body field
 * naming a user would be an IDOR waiting to happen — the same class of bug as
 * CWE-639, which this repository has already shipped once.
 *
 * Two endpoints carry the sync contract (D11):
 *
 *   GET  /api/planner/pull?since=<cursor>   — changes, plus the server clock
 *   POST /api/planner/push                  — operations, merged server-side
 *
 * The rest are conveniences for surfaces that only want to read.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as planner from "../../memory/planner/backend.js";

export const plannerRouter = Router();
plannerRouter.use(requireAnyAuth);

/** Beyond this a single push is not a sync, it is a bulk import. */
const MAX_PUSH_OPERATIONS = 200;

plannerRouter.get("/pull", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  try {
    const { items, cursor } = await planner.pullChanges(req.orgId!, req.userId!, since);
    res.json({ items, cursor, serverClock: planner.serverClock(Date.now()) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "pull failed" });
  }
});

plannerRouter.post("/push", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const operations = Array.isArray(body.operations) ? body.operations : null;

  if (!operations) {
    res.status(400).json({ error: "operations must be an array" });
    return;
  }
  if (operations.length > MAX_PUSH_OPERATIONS) {
    // Refused with the limit named, so the client can split rather than guess.
    res.status(413).json({
      error: `A push carries at most ${MAX_PUSH_OPERATIONS} operations; this had ${operations.length}. Send them in batches.`,
    });
    return;
  }

  const valid: planner.PushOperation[] = [];
  const rejected: Array<{ idempotencyKey: string; reason: string }> = [];

  for (const raw of operations) {
    const op = raw as Record<string, unknown>;
    // Malformed operations are REJECTED individually rather than failing the
    // batch: one bad entry must not strand every good one in the client's
    // outbox, where it would retry forever.
    if (typeof op.idempotencyKey !== "string" || typeof op.itemId !== "string") {
      rejected.push({
        idempotencyKey: typeof op.idempotencyKey === "string" ? op.idempotencyKey : "unknown",
        reason: "The operation is missing an idempotency key or item id.",
      });
      continue;
    }
    valid.push(op as unknown as planner.PushOperation);
  }

  try {
    const outcome = await planner.pushOperations(
      req.orgId!, req.userId!, valid, new Date().toISOString(),
    );
    res.json({
      accepted: outcome.accepted,
      rejected: [...rejected, ...outcome.rejected],
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "push failed" });
  }
});

plannerRouter.get("/items", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const { items } = await planner.pullChanges(req.orgId!, req.userId!);
  // Tombstones are a sync concern, not a read concern — a surface asking for
  // items wants the ones that exist.
  res.json({ items: items.filter((i) => !i.deletedAt) });
});

plannerRouter.get("/blocks", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ blocks: await planner.listBlocks(req.orgId!, req.userId!) });
});
