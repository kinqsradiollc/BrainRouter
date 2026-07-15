/**
 * Meetings API (ADR-018). Authenticated, org-scoped list/detail/create/scope; plus a
 * separate UNAUTHENTICATED public read for a share token (redacted summary only).
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as meetings from "../../memory/meetings/backend.js";
import { isMeetingVisibility } from "../../memory/meetings/sharing.js";

export const meetingsRouter = Router();
meetingsRouter.use(requireAnyAuth);

meetingsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { res.status(400).json({ error: "Invalid meetings limit" }); return; }
  try {
    res.json(await meetings.listMeetingsPage(req.userId!, req.orgId!, typeof req.query.cursor === "string" ? req.query.cursor : undefined, limit));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid meetings cursor" });
  }
});

meetingsRouter.get("/:id/overview", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const overview = await meetings.getMeetingOverview(req.userId!, req.orgId!, String(req.params.id));
  if (!overview) { res.status(404).json({ error: "Meeting not found" }); return; }
  res.json(overview);
});

meetingsRouter.get("/:id/transcript", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const cursor = req.query.cursor == null ? 0 : Number(req.query.cursor);
  const limit = req.query.limit == null ? 100 : Number(req.query.limit);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    res.status(400).json({ error: "Invalid transcript cursor or limit" }); return;
  }
  const page = await meetings.getMeetingTranscriptPage(req.userId!, req.orgId!, String(req.params.id), cursor, limit);
  if (!page) { res.status(404).json({ error: "Meeting not found" }); return; }
  res.json(page);
});

meetingsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as { title?: unknown; transcript?: unknown; scope?: unknown; teamId?: unknown; date?: unknown; attendees?: unknown; template?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const transcript = typeof body.transcript === "string" ? body.transcript : "";
  if (!title || !transcript.trim()) { res.status(400).json({ error: "title and transcript are required" }); return; }
  const scope = isMeetingVisibility(body.scope) ? body.scope : "private";
  const template = ["general", "standup", "one-on-one", "retrospective"].includes(String(body.template)) ? body.template as "general" | "standup" | "one-on-one" | "retrospective" : "general";
  try {
    const out = await meetings.createMeeting({
      userId: req.userId!, orgId: req.orgId!, title, transcript, scope,
      teamId: typeof body.teamId === "string" ? body.teamId : undefined,
      date: typeof body.date === "string" ? body.date : undefined,
      attendees: Array.isArray(body.attendees) ? body.attendees.filter((a): a is string => typeof a === "string") : undefined,
      template,
    });
    res.status(201).json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not create meeting." });
  }
});

meetingsRouter.get("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const detail = await meetings.getMeeting(req.userId!, req.orgId!, String(req.params.id));
  if (!detail) { res.status(404).json({ error: "Meeting not found" }); return; }
  res.json(detail);
});

meetingsRouter.post("/:id/regenerate", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const detail = await meetings.regenerateSummary(req.userId!, req.orgId!, String(req.params.id));
  if (!detail) { res.status(404).json({ error: "Meeting not found, or you are not its owner." }); return; }
  res.json(detail);
});

meetingsRouter.patch("/:id/summary", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as { summaryMarkdown?: unknown };
  if (typeof body.summaryMarkdown !== "string") { res.status(400).json({ error: "summaryMarkdown is required" }); return; }
  const detail = await meetings.updateSummary(req.userId!, req.orgId!, String(req.params.id), body.summaryMarkdown);
  if (!detail) { res.status(404).json({ error: "Meeting not found, or you are not its owner." }); return; }
  res.json(detail);
});

meetingsRouter.post("/:id/actions/:actionId", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as { done?: unknown; trackItemId?: unknown };
  const ok = await meetings.setActionItemState(req.userId!, req.orgId!, String(req.params.id), String(req.params.actionId), {
    ...(typeof body.done === "boolean" ? { done: body.done } : {}),
    ...(typeof body.trackItemId === "string" ? { trackItemId: body.trackItemId } : {}),
  });
  if (!ok) { res.status(404).json({ error: "Action item not found, or you are not the owner." }); return; }
  res.json({ ok: true });
});

meetingsRouter.post("/:id/scope", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as { scope?: unknown; teamId?: unknown; from?: unknown };
  if (!isMeetingVisibility(body.scope)) { res.status(400).json({ error: "invalid scope" }); return; }
  try {
    const share = await meetings.setScope({
      userId: req.userId!, orgId: req.orgId!, id: String(req.params.id), scope: body.scope,
      teamId: typeof body.teamId === "string" ? body.teamId : undefined,
      from: isMeetingVisibility(body.from) ? body.from : undefined,
    });
    res.json(share);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Could not change sharing." });
  }
});

/** Unauthenticated public read — redacted summary only, for an active share token. */
export const publicMeetingsRouter = Router();
publicMeetingsRouter.get("/:token", async (req, res) => {
  const meeting = await meetings.getByShareToken(String(req.params.token));
  if (!meeting) { res.status(404).json({ error: "This link is invalid or has expired." }); return; }
  res.json(meeting);
});
