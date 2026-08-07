/**
 * Notes API — authenticated, per-USER sync for ADR-029 Part D (migration 052).
 *
 * Every route is keyed by `(orgId, userId)` from the authenticated session and
 * never by anything the caller sends. Notes are personal (D1), so a body field
 * naming a user would be an IDOR waiting to happen — the same class of bug as
 * CWE-639, which this repository has already shipped once.
 *
 * Two endpoints carry the sync contract (ADR-028 D11):
 *
 *   GET  /api/notes/pull?since=<cursor>  — changes, plus the server clock
 *   POST /api/notes/push                 — operations, MERGED server-side
 *
 * The lease routes are the other half of B2: the lock lives on the server
 * because that is the only place two devices can see the same one.
 */
import { Router, type Response } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as notes from "../../memory/notes/backend.js";
import type { LeaseOutcome } from "@kinqs/brainrouter-core/notes";

export const notesRouter = Router();
notesRouter.use(requireAnyAuth);

/** Beyond this a single push is not a sync, it is a bulk import. */
const MAX_PUSH_OPERATIONS = 200;
const MAX_SEARCH_RESULTS = 100;
/**
 * Part E's read bounds. A page and a database are both unbounded shapes, and Q3's
 * argument for the agent's context is the same one here: a response with no upper
 * limit is one the caller discovers by timing out. Both endpoints report what
 * they read against what exists, so a prefix is never mistaken for the whole.
 */
const MAX_PAGE_BLOCKS = 1000;
const MAX_DATABASE_ROWS = 500;

function boundedLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

/**
 * A refused lease is a 409 with the reason NAMED.
 *
 * B2 requires an attribution the person can act on, and "someone else is editing
 * this" and "your lock expired" lead to different actions — collapsing them into
 * one failure is what migration 048's complete/fail paths do, and it is the one
 * thing about that pattern worth not copying.
 */
function sendLease(res: Response, outcome: LeaseOutcome): void {
  if (outcome.ok) {
    res.json({ lease: outcome.lease });
    return;
  }
  res.status(409).json({
    reason: outcome.reason,
    detail: outcome.detail,
    ...(outcome.holder ? { holder: { deviceId: outcome.holder.deviceId, holder: outcome.holder.holder, expiresAt: outcome.holder.expiresAt } } : {}),
  });
}

notesRouter.get("/pull", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const since = typeof req.query.since === "string" ? req.query.since : undefined;
  try {
    const { blocks, cursor } = await notes.pullChanges(req.orgId!, req.userId!, since);
    res.json({ items: blocks, cursor, serverClock: notes.serverClock(Date.now()) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "pull failed" });
  }
});

notesRouter.post("/push", async (req: AuthedRequest, res) => {
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

  const valid: notes.NotePushOperation[] = [];
  const rejected: Array<{ idempotencyKey: string; reason: string }> = [];
  for (const raw of operations) {
    const op = raw as Record<string, unknown>;
    // Malformed operations are REJECTED individually rather than failing the
    // batch: one bad entry must not strand every good one in the client's
    // outbox, where it would retry forever.
    if (typeof op.idempotencyKey !== "string" || typeof op.itemId !== "string") {
      rejected.push({
        idempotencyKey: typeof op.idempotencyKey === "string" ? op.idempotencyKey : "unknown",
        reason: "The operation is missing an idempotency key or block id.",
      });
      continue;
    }
    valid.push(op as unknown as notes.NotePushOperation);
  }

  try {
    const outcome = await notes.pushOperations(req.orgId!, req.userId!, valid);
    res.json({ accepted: outcome.accepted, rejected: [...rejected, ...outcome.rejected] });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "push failed" });
  }
});

notesRouter.get("/blocks", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ blocks: await notes.listBlocks(req.orgId!, req.userId!) });
});

/** C1's `create`, over HTTP — the path a dashboard or a cross-mode create takes. */
notesRouter.post("/blocks", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const block = await notes.createBlock(
      req.orgId!,
      req.userId!,
      {
        ...(typeof body.kind === "string" ? { kind: body.kind as never } : {}),
        ...(typeof body.text === "string" ? { text: body.text } : {}),
        ...(typeof body.parentId === "string" ? { parentId: body.parentId } : {}),
        ...(body.level !== undefined ? { level: Number(body.level) } : {}),
      },
      Date.now(),
    );
    res.status(201).json({ block });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "create failed" });
  }
});

/* --------------------------------------------------- Part E: pages and views */

/**
 * ADR-029 E4 — the sidebar, and the reason migration 053 exists.
 *
 * `/blocks` returns every block a person owns, which is the right answer for a
 * device building its own cache and the wrong one for a navigator: rendering
 * forty page titles should not mean shipping every paragraph they have ever
 * typed. This reads the derived projection instead.
 */
notesRouter.get("/pages", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const favouritesOnly = req.query.favourites === "1" || req.query.favourites === "true";
  res.json({
    pages: await notes.listPages(req.orgId!, req.userId!, { favouritesOnly }),
  });
});

/** E4's favourites section. Any block, not only a page — people pin lines too. */
notesRouter.get("/favourites", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ favourites: await notes.listFavourites(req.orgId!, req.userId!) });
});

/**
 * One page, with its blocks in document order.
 *
 * Bounded, and `truncated` says so. A page is unbounded (Q3's argument, applied
 * to an HTTP response), so a caller that is not told it received a prefix will
 * render a document that silently stops.
 */
notesRouter.get("/pages/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const page = await notes.readPage(req.orgId!, req.userId!, String(req.params.id), MAX_PAGE_BLOCKS);
  if (!page) {
    res.status(404).json({ error: "No such page." });
    return;
  }
  res.json(page);
});

/** E3's picker: every database, with the columns a row would get. */
notesRouter.get("/databases", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ databases: await notes.listDatabases(req.orgId!, req.userId!) });
});

/**
 * E3 — one database, projected through one of its views.
 *
 * The projection is core's `projectDatabase`, the same function the desktop
 * runs. A view language expressed twice would drift, and the symptom is the same
 * board showing different cards on two screens with nothing to say which is
 * right.
 */
notesRouter.get("/databases/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const view = await notes.readDatabaseView(req.orgId!, req.userId!, String(req.params.id), {
    ...(typeof req.query.view === "string" ? { viewId: req.query.view } : {}),
    limit: boundedLimit(req.query.limit, MAX_DATABASE_ROWS, MAX_DATABASE_ROWS),
  });
  if (!view) {
    // A paragraph is not a database with no rows. Refused rather than projected,
    // because a caller has no way to tell an empty view from a block that was
    // never one.
    res.status(404).json({ error: "No such database." });
    return;
  }
  res.json(view);
});

notesRouter.get("/search", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const limit = boundedLimit(req.query.limit, 50, MAX_SEARCH_RESULTS);
  res.json({ hits: await notes.searchBlocks(req.orgId!, req.userId!, q, limit) });
});

/**
 * "What links here" (A2). The target is a URI; the answer is derived.
 *
 * Scoped to what this viewer may see — backlinks over a wider corpus would
 * answer the question with the existence of notes they cannot open.
 */
notesRouter.get("/backlinks", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const target = typeof req.query.target === "string" ? req.query.target : "";
  const found = await notes.backlinksTo(req.orgId!, req.userId!, target);
  if (!found) {
    res.status(400).json({ error: "target must be a brainrouter:// reference" });
    return;
  }
  res.json(found);
});

/**
 * Rebuild the derived tables from block content alone (A2).
 *
 * Exposed rather than left as an internal because the rule it enforces —
 * rebuilding must not change the answer — is only a rule if it can be run.
 */
notesRouter.post("/reindex", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json(await notes.rebuildDerived(req.orgId!, req.userId!));
});

notesRouter.get("/blocks/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const block = await notes.getBlock(req.orgId!, req.userId!, String(req.params.id));
  if (!block) {
    res.status(404).json({ error: "No such block." });
    return;
  }
  res.json({ block });
});

notesRouter.put("/blocks/:id/visibility", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const visibility = (req.body ?? {}).visibility;
  if (visibility !== "private" && visibility !== "team" && visibility !== "org") {
    res.status(400).json({ error: "visibility is private, team or org" });
    return;
  }
  const changed = await notes.setVisibility(req.orgId!, req.userId!, String(req.params.id), visibility);
  if (!changed) {
    res.status(404).json({ error: "No such block." });
    return;
  }
  res.json({ ok: true, visibility });
});

notesRouter.get("/blocks/:id/refs", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ refs: await notes.referencesFrom(req.orgId!, req.userId!, String(req.params.id)) });
});

/* ------------------------------------------------------------------ leases */

notesRouter.get("/blocks/:id/lease", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json(await notes.readLease(req.orgId!, req.userId!, String(req.params.id)));
});

notesRouter.post("/blocks/:id/lease", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || !body.deviceId.trim()) {
    res.status(400).json({ error: "deviceId is required to hold a lock" });
    return;
  }
  const outcome = await notes.acquireLease(req.orgId!, req.userId!, String(req.params.id), {
    deviceId: body.deviceId,
    ...(typeof body.holder === "string" ? { holder: body.holder } : {}),
  });
  sendLease(res, outcome);
});

notesRouter.post("/blocks/:id/lease/renew", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || typeof body.epoch !== "number") {
    res.status(400).json({ error: "a renewal carries the deviceId and the epoch it believes it holds" });
    return;
  }
  sendLease(res, await notes.renewLease(req.orgId!, req.userId!, String(req.params.id), {
    deviceId: body.deviceId, epoch: body.epoch,
  }));
});

notesRouter.post("/blocks/:id/lease/release", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || typeof body.epoch !== "number") {
    res.status(400).json({ error: "a release carries the deviceId and the epoch it believes it holds" });
    return;
  }
  sendLease(res, await notes.releaseLease(req.orgId!, req.userId!, String(req.params.id), {
    deviceId: body.deviceId, epoch: body.epoch,
  }));
});

/* -------------------------------------------------------------- attachments */

/**
 * D3 — register the object, then point blocks at it.
 *
 * Registration takes the digest and the size, not the bytes: the same image
 * pasted into a third note adds a reference and no storage. The upload of the
 * bytes themselves is the caller's, and `storageKey` records where they went.
 */
notesRouter.post("/attachments", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const object = await notes.registerAttachment(req.orgId!, {
      contentHash: String(body.contentHash ?? ""),
      byteSize: Number(body.byteSize ?? -1),
      mediaType: String(body.mediaType ?? "application/octet-stream"),
      storageKey: String(body.storageKey ?? ""),
    });
    res.json({ attachment: object, uses: await notes.attachmentUses(req.orgId!, object.contentHash) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "could not register the attachment" });
  }
});

notesRouter.get("/blocks/:id/attachments", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ attachments: await notes.blockAttachments(req.orgId!, req.userId!, String(req.params.id)) });
});

notesRouter.post("/blocks/:id/attachments", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    await notes.attachToBlock(
      req.orgId!, req.userId!, String(req.params.id),
      String(body.contentHash ?? ""),
      typeof body.fileName === "string" ? body.fileName : null,
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "could not attach" });
  }
});

notesRouter.delete("/blocks/:id/attachments/:hash", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const removed = await notes.detachFromBlock(req.orgId!, req.userId!, String(req.params.id), String(req.params.hash));
  res.json({ ok: removed, uses: await notes.attachmentUses(req.orgId!, String(req.params.hash)) });
});
