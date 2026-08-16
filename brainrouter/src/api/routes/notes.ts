/**
 * Notes API — authenticated, per-USER sync for ADR-029 Part D (migration 052).
 *
 * Every route is keyed by `(orgId, userId)` from the authenticated session and
 * never by anything the caller sends. Notes are personal (D1), so a body field
 * naming a user would be an IDOR waiting to happen — the same class of bug as
 * CWE-639, which this repository has already shipped once.
 *
 * Two backwards-compatible endpoints carry device sync (ADR-028 D11):
 *
 *   GET  /api/notes/pull?since=<cursor>  — changes, plus the server clock
 *   POST /api/notes/push                 — operations, MERGED server-side
 *
 * ADR-038 adds `/mutate` as the higher-level browser gesture seam; it composes
 * the same push path rather than becoming another Notes writer.
 *
 * The lease routes are the other half of B2: the lock lives on the server
 * because that is the only place two devices can see the same one.
 */
import { Router, type Response } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as notes from "../../memory/notes/backend.js";
import {
  MAX_COMMENT_LENGTH, type LeaseOutcome, type NoteExportFormat,
} from "@kinqs/brainrouter-core/notes";
import {
  EMPTY_NOTES_MUTATION_SYNC, NOTES_EDITING_CAPABILITIES,
  NOTES_EDITING_CONTRACT_VERSION, REMOTE_NOTES_HISTORY_STATE,
  parseNotesMutationRequest, type NotesMutationErrorCode,
} from "@kinqs/brainrouter-core/notes/editing";

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

/**
 * ADR-029 F3's bounds, applied to a FILE rather than to a screen.
 *
 * Core's writers have their own ceilings (5,000 blocks / 4,000,000 characters)
 * and these are deliberately tighter, because an export is the one read that
 * builds its whole answer in memory and then sends all of it: a page nobody
 * meant to make can turn one click into a multi-megabyte response. Both halves
 * of the cap are reported — the file says so in its own text where Markdown can
 * carry a sentence, and the headers say so for CSV, which cannot hold a note
 * without becoming a row.
 */
const MAX_EXPORT_FILE_BLOCKS = 2000;
const MAX_EXPORT_FILE_CHARS = 2_000_000;


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
    const parsed = notes.parseNotePushOperation(raw);
    // Malformed operations are REJECTED individually rather than failing the
    // batch: one bad entry must not strand every good one in the client's
    // outbox, where it would retry forever.
    if (!parsed.ok) rejected.push({ idempotencyKey: parsed.idempotencyKey, reason: parsed.reason });
    else valid.push(parsed.value);
  }

  try {
    const outcome = await notes.pushOperations(req.orgId!, req.userId!, valid);
    res.json({
      accepted: outcome.accepted,
      rejected: [...rejected, ...outcome.rejected],
      fenced: outcome.fenced ?? [],
    });
  } catch (error) {
    console.error("notes push failed", error);
    res.status(503).json({ error: "The Notes service could not apply this push. Retry it." });
  }
});

/**
 * ADR-038 — the capability document a Dashboard adapter gates controls from.
 *
 * In particular it says remote undo and JSON attachment bytes are unavailable;
 * a control that cannot be honoured is hidden/disabled from this response
 * rather than wired to a successful no-op.
 */
notesRouter.get("/mutate/capabilities", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json(NOTES_EDITING_CAPABILITIES);
});

function mutationStatus(code: NotesMutationErrorCode): number {
  switch (code) {
    case "invalid_request": return 400;
    case "not_found": return 404;
    case "locked":
    case "refused":
    case "idempotency_conflict":
    case "stale_conflict":
    case "sync_rejected": return 409;
    case "limit_exceeded": return 413;
    case "unsupported_capability": return 422;
    case "internal_error": return 500;
  }
}

/**
 * The one writable Notes host seam for browser renderers.
 *
 * `/push` remains the backwards-compatible device outbox transport. This route
 * accepts the higher-level operation vocabulary from Core, executes Core's pure
 * gesture/database policy, and reports the primitive sync outcome. Org/user
 * scope comes exclusively from the authenticated request, never the body.
 */
notesRouter.post("/mutate", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const parsed = parseNotesMutationRequest(req.body);
  if (!parsed.ok) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const operation = body.operation && typeof body.operation === "object"
      ? (body.operation as { type?: unknown }).type
      : undefined;
    res.status(400).json({
      version: NOTES_EDITING_CONTRACT_VERSION,
      requestId: typeof body.requestId === "string" ? body.requestId.slice(0, 128) : "invalid",
      operation: typeof operation === "string" ? operation : "unknown",
      ok: false,
      error: {
        code: "invalid_request",
        detail: `${parsed.error.path}: ${parsed.error.detail}`,
        retryable: false,
      },
      sync: EMPTY_NOTES_MUTATION_SYNC,
      history: REMOTE_NOTES_HISTORY_STATE,
    });
    return;
  }

  try {
    const outcome = await notes.mutateNotes(
      req.orgId!, req.userId!, parsed.value, Date.now(),
    );
    res.status(outcome.ok ? 200 : mutationStatus(outcome.error.code)).json(outcome);
  } catch (error) {
    console.error("notes mutation failed", error);
    res.status(500).json({
      version: NOTES_EDITING_CONTRACT_VERSION,
      requestId: parsed.value.requestId,
      operation: parsed.value.operation.type,
      ok: false,
      error: {
        code: "internal_error",
        detail: "The server could not apply this Notes mutation. Retry the request.",
        retryable: true,
      },
      sync: EMPTY_NOTES_MUTATION_SYNC,
      history: REMOTE_NOTES_HISTORY_STATE,
    });
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

/** C5 — full scoped tombstone projection; never inferred from bounded `/pull`. */
notesRouter.get("/trash", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ entries: await notes.listTrash(req.orgId!, req.userId!) });
});

/** C5 — comments remain discoverable when their target block is in the trash. */
notesRouter.get("/comments/orphaned", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  res.json({ threads: await notes.listOrphanedCommentThreads(req.orgId!, req.userId!) });
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

/** F2 — columns on the databases reached by one relation property. */
notesRouter.get("/databases/:id/rollup-targets", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const relation = typeof req.query.relation === "string" ? req.query.relation.trim() : "";
  if (!relation || relation.length > 256 || /[\u0000-\u001f\u007f]/u.test(relation)) {
    res.status(400).json({ ok: false, detail: "relation must be a valid property id" });
    return;
  }
  const outcome = await notes.readRollupTargetProperties(
    req.orgId!, req.userId!, String(req.params.id), relation,
  );
  if (!outcome.ok) {
    res.status(outcome.reason === "refused" ? 409 : 404).json({
      ok: false,
      detail: outcome.detail,
    });
    return;
  }
  res.json({
    ok: true,
    properties: outcome.value.properties.map(({ id, name, type }) => ({ id, name, type })),
    databases: outcome.value.databases,
  });
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

/* ------------------------------------------------------------------ export */

/**
 * ADR-029 F3 — "can I leave", as a download.
 *
 * One route for both formats rather than one per shape, because that is how
 * core's door is built: `exportNote` takes a block and a FORMAT and knows that a
 * page goes to Markdown and a database goes to CSV. A `/pages/:id/export` beside
 * a `/databases/:id/export` would put that decision on this side as well, and
 * two places that decide it are two places that can start disagreeing about
 * whether a database is also a page (B4 says it is).
 *
 * **A format this block cannot be written as is a 400 that NAMES the ones it
 * can.** F1's rule is that an offer the product cannot honour is worse than an
 * absence, so the refusal is the thing a menu builds itself from rather than a
 * dead end. (`/pages/:id` and `/databases/:id` carry the same list, so the menu
 * never has to ask.)
 *
 * **The response is a file.** `Content-Disposition: attachment` with core's
 * filename, which is character-classed down to `[A-Za-z0-9-]` plus the
 * extension in `exportFilename` — a title carrying a quote or a newline is a
 * header-injection shape, and the answer there was to keep the alphabet small
 * rather than to escape a large one correctly. `no-store`, because this is one
 * person's document and a shared cache is the wrong place for it.
 */
notesRouter.get("/blocks/:id/export", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const requested = typeof req.query.format === "string" ? req.query.format : "markdown";
  if (requested !== "markdown" && requested !== "csv") {
    res.status(400).json({ error: "format is markdown or csv" });
    return;
  }
  const format: NoteExportFormat = requested;

  const outcome = await notes.exportBlock(req.orgId!, req.userId!, String(req.params.id), format, {
    ...(typeof req.query.view === "string" ? { viewId: req.query.view } : {}),
    maxBlocks: MAX_EXPORT_FILE_BLOCKS,
    maxChars: MAX_EXPORT_FILE_CHARS,
  });

  if (!outcome.ok) {
    if (outcome.reason === "wrong_format") {
      res.status(400).json({
        error: outcome.formats.length > 0
          ? `This cannot be written as ${format}. It can be written as ${outcome.formats.join(" or ")}.`
          : `This cannot be written as ${format}.`,
        formats: outcome.formats,
      });
      return;
    }
    res.status(404).json({ error: "No such block." });
    return;
  }

  const { file } = outcome;
  res.setHeader("Content-Type", file.contentType);
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-BrainRouter-Export-Count", String(file.count));
  // Stated rather than inferred from a length, and stated for CSV especially:
  // Markdown carries "what this file does not carry" inside the document, and a
  // spreadsheet has nowhere to put a sentence that is not also a row.
  res.setHeader("X-BrainRouter-Export-Truncated", file.truncated ? "1" : "0");
  // The KINDS, never the sentences. These are a fixed enum from core, so nothing
  // a person typed reaches a response header — which is the only place in this
  // route where user text could have become a header-injection question.
  res.setHeader(
    "X-BrainRouter-Export-Omissions",
    [...new Set(file.omissions.map((omission) => omission.kind))].join(","),
  );
  res.send(file.content);
});

/* ---------------------------------------------------------------- comments */

/**
 * ADR-029 F3 — the thread on one block.
 *
 * Scoped to `(org_id, user_id, id)` like every other read here, which is what
 * makes "a comment is never readable by somebody who could not read its block"
 * true by construction rather than by a check somebody has to remember.
 *
 * **A deleted block still answers, with `blockDeleted` set.** C5: deleting the
 * target of a link never deletes the link, and 404-ing the thread would make a
 * remark unreachable because the line it was about went away — which is the one
 * moment somebody goes looking for it.
 */
notesRouter.get("/blocks/:id/comments", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const thread = await notes.readCommentThread(req.orgId!, req.userId!, String(req.params.id));
  if (!thread) {
    res.status(404).json({ error: "No such block." });
    return;
  }
  res.json(thread);
});

/**
 * Leave a remark. It travels the ordinary push path — see `pushComment`.
 *
 * There is no second write path here on purpose (B3): the operation this builds
 * is the same one the desktop's outbox sends, merged per comment key against
 * whatever the server already holds.
 */
notesRouter.post("/blocks/:id/comments", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    res.status(400).json({ error: "A comment needs something to say." });
    return;
  }
  if (text.length > MAX_COMMENT_LENGTH) {
    // Refused with the limit named rather than silently truncated: somebody
    // whose last paragraph vanished has no way to tell that from a sync failure.
    res.status(400).json({
      error: `A comment holds at most ${MAX_COMMENT_LENGTH} characters; this one had ${text.length}.`,
    });
    return;
  }

  const outcome = await notes.addComment(
    req.orgId!, req.userId!, String(req.params.id),
    { body: text, ...(typeof body.author === "string" ? { author: body.author } : {}) },
    Date.now(),
  );
  sendComment(res, outcome, 201);
});

/** F3's "resolved and unresolved" — one stamped field, merged like any other. */
notesRouter.patch("/blocks/:id/comments/:commentId", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.resolved !== "boolean") {
    res.status(400).json({ error: "resolved is true or false" });
    return;
  }
  const outcome = await notes.setCommentResolved(
    req.orgId!, req.userId!, String(req.params.id), String(req.params.commentId),
    body.resolved, Date.now(),
  );
  sendComment(res, outcome, 200);
});

/**
 * One refusal per cause, because the causes lead somewhere different.
 *
 * "There is no such block" and "the merge would not take this" are the same
 * status to a caller that collapses them, and one of those is worth retrying.
 */
function sendComment(res: Response, outcome: notes.CommentWriteOutcome, okStatus: number): void {
  if (outcome.ok) {
    res.status(okStatus).json({ comment: outcome.comment, blockDeleted: outcome.blockDeleted });
    return;
  }
  if (outcome.reason === "refused") {
    res.status(409).json({ error: outcome.detail ?? "The server could not apply this comment." });
    return;
  }
  res.status(404).json({
    error: outcome.reason === "no_block" ? "No such block." : "No such comment.",
  });
}

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
