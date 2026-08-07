/**
 * Workspace reference API — ADR-029 C1's three verbs, over HTTP.
 *
 *   GET  /api/workspace/resolve?uri=…   the current state, or a tombstone
 *   GET  /api/workspace/describe?uri=…  the one-line label, cheaply
 *   POST /api/workspace/create          make a thing of another mode's kind
 *
 * Q5 is the reason this exists on the server at all: the dashboard has no local
 * store to resolve against, and the desktop and the CLI are two more processes
 * reading the same backend. An in-process object reference cannot cross that
 * boundary; a string can.
 *
 * The viewer is always the authenticated session (A4). A resolve that took its
 * identity from the request body would render another person's private note as
 * its title — the leak A4 exists to prevent, handed over on request.
 *
 * Every non-`found` sentence is produced by `renderWorkspaceResolution` in core
 * rather than here, so the wording for "you cannot see this" is written once for
 * the whole product instead of once per surface.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import {
  parseWorkspaceRef, renderWorkspaceResolution, resolvedUnavailable,
} from "@kinqs/brainrouter-core/workspace/references";
import { workspaceRegistry } from "../../memory/workspace/registry.js";
import * as notes from "../../memory/notes/backend.js";

export const workspaceRouter = Router();
workspaceRouter.use(requireAnyAuth);

/** What the modes a "make this a …" menu may offer, and what they answer for. */
workspaceRouter.get("/modes", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const registry = workspaceRegistry();
  res.json({ modes: registry.modes(), creatable: registry.creatableModes() });
});

workspaceRouter.get("/resolve", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const uri = typeof req.query.uri === "string" ? req.query.uri : "";
  const resolution = await workspaceRegistry().resolveUri(uri, { userId: req.userId!, orgId: req.orgId! });
  // Always 200: every outcome — denied, gone, unavailable — is an ANSWER the
  // caller renders inline, not an error it should retry or log. A 404 for a
  // tombstone would make a deleted target indistinguishable from a broken
  // endpoint, which is exactly the ambiguity A3 refuses.
  res.json({ resolution, line: renderWorkspaceResolution(resolution) });
});

workspaceRouter.get("/describe", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const parsed = parseWorkspaceRef(typeof req.query.uri === "string" ? req.query.uri : "");
  // Parsed here rather than through `resolveUri`, because that would run the
  // full resolve — and the whole point of describe is the cheaper read.
  if (!parsed.ok) {
    res.json({ line: renderWorkspaceResolution(resolvedUnavailable(null, "malformed_ref", parsed.detail)) });
    return;
  }
  res.json({ line: await workspaceRegistry().describeLine(parsed.ref, { userId: req.userId!, orgId: req.orgId! }) });
});

/**
 * C1's `create`, and Q2's decision that it is synchronous.
 *
 * The new URI comes back in the response because the CALLER writes it into its
 * own content (A2 keeps the reference at the referring end). An async create
 * that failed after the note was saved would leave a note claiming a task that
 * does not exist.
 */
workspaceRouter.post("/create", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.mode !== "string" || typeof body.kind !== "string" || typeof body.title !== "string") {
    res.status(400).json({ error: "mode, kind and title are required" });
    return;
  }
  const outcome = await workspaceRegistry().create(
    {
      mode: body.mode,
      kind: body.kind,
      title: body.title,
      ...(body.from && typeof body.from === "object" ? { from: body.from as never } : {}),
      ...(body.fields && typeof body.fields === "object" ? { fields: body.fields as Record<string, unknown> } : {}),
    },
    { userId: req.userId!, orgId: req.orgId! },
  );
  // A refusal is a 4xx with the reason: the caller is deciding whether to write
  // a reference into a document and needs an answer it can branch on.
  res.status(outcome.status === "refused" ? 400 : 200).json(outcome);
});

/**
 * ADR-029 C1's fourth verb, over HTTP.
 *
 * The same seam `create` has and for the same reason: a surface with no local
 * store — the dashboard — can only change another mode's record by asking the
 * mode that owns it, and the alternative is a per-mode write endpoint per
 * surface, which is the drift C3 is organised against.
 */
workspaceRouter.post("/update", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseWorkspaceRef(typeof body.uri === "string" ? body.uri : "");
  if (!parsed.ok) {
    res.status(400).json({ error: `uri is not a reference: ${parsed.detail}` });
    return;
  }
  const outcome = await workspaceRegistry().update(
    {
      ref: parsed.ref,
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.fields && typeof body.fields === "object" ? { fields: body.fields as Record<string, unknown> } : {}),
    },
    { userId: req.userId!, orgId: req.orgId! },
  );
  // A refusal is a 4xx with the reason named: "another device is editing this"
  // and "there is no such record" lead somewhere different, and a caller given
  // one status for both retries forever against a lock that is doing its job.
  res.status(outcome.status === "refused" ? 400 : 200).json(outcome);
});

/**
 * What links here (A2), across the workspace.
 *
 * Only notes answer today, because only notes store references in content that
 * this backend indexes. A chat turn or a meeting summary containing a URI would
 * join by getting an entry in the same derived table — the query does not change.
 */
workspaceRouter.get("/backlinks", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const uri = typeof req.query.uri === "string" ? req.query.uri : "";
  const found = await notes.backlinksTo(req.orgId!, req.userId!, uri);
  if (!found) {
    res.status(400).json({ error: "uri must be a brainrouter:// reference" });
    return;
  }
  res.json(found);
});
