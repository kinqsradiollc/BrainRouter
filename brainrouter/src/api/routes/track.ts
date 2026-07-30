/**
 * Track API — authenticated, org-scoped CRUD for Track work items (migration 034).
 * Collaborative within an org: any member may list/create/transition/update/delete,
 * and every query is keyed by the caller's org so cross-org access is impossible.
 */
import { Router } from "express";
import { requireAnyAuth, type AuthedRequest } from "../middleware/auth.js";
import { attachOrgContext } from "../middleware/tenancy.js";
import * as track from "../../memory/track/backend.js";

const CATEGORIES = new Set(["todo", "in_progress", "completed"]);
function asCategory(v: unknown): track.TrackStatusCategory | undefined {
  return typeof v === "string" && CATEGORIES.has(v) ? (v as track.TrackStatusCategory) : undefined;
}

export const trackRouter = Router();
trackRouter.use(requireAnyAuth);

trackRouter.get("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";
  res.json({ items: await track.listTrack(req.orgId!, includeArchived) });
});

trackRouter.post("/", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.title !== "string" || !body.title.trim()) { res.status(400).json({ error: "title is required" }); return; }
  try {
    const item = await track.createTrack(req.orgId!, req.userId!, {
      title: body.title,
      description: typeof body.description === "string" ? body.description : undefined,
      type: typeof body.type === "string" ? body.type : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
      statusCategory: asCategory(body.statusCategory),
      priority: typeof body.priority === "string" ? body.priority : undefined,
      assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      labels: Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === "string") : undefined,
    });
    res.status(201).json({ item });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Could not create track item" });
  }
});

trackRouter.get("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const item = await track.getTrack(req.orgId!, String(req.params.id));
  if (!item) { res.status(404).json({ error: "Track item not found" }); return; }
  res.json({ item });
});

/** Move an item to a new status bucket (drives the board columns + done checkbox). */
trackRouter.post("/:id/transition", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const category = asCategory(body.statusCategory);
  if (!category) { res.status(400).json({ error: "statusCategory must be todo|in_progress|completed" }); return; }
  const status = typeof body.status === "string" && body.status.trim() ? body.status.trim() : category;
  const item = await track.transitionTrack(req.orgId!, String(req.params.id), status, category);
  if (!item) { res.status(404).json({ error: "Track item not found" }); return; }
  res.json({ item });
});

trackRouter.patch("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: track.UpdateTrackItemPatch = {};
  if (typeof body.title === "string") patch.title = body.title;
  if (typeof body.description === "string") patch.description = body.description;
  if (typeof body.priority === "string") patch.priority = body.priority;
  if (typeof body.assignee === "string" || body.assignee === null) patch.assignee = body.assignee as string | null;
  if (Array.isArray(body.labels)) patch.labels = body.labels.filter((x): x is string => typeof x === "string");
  if (typeof body.status === "string") patch.status = body.status;
  const category = asCategory(body.statusCategory);
  if (category) patch.statusCategory = category;
  if (body.archived === true) patch.archivedAt = new Date().toISOString();
  if (body.archived === false) patch.archivedAt = null;
  const item = await track.updateTrack(req.orgId!, String(req.params.id), patch);
  if (!item) { res.status(404).json({ error: "Track item not found" }); return; }
  res.json({ item });
});

trackRouter.delete("/:id", async (req: AuthedRequest, res) => {
  if (!(await attachOrgContext(req, res))) return;
  const ok = await track.deleteTrack(req.orgId!, String(req.params.id));
  res.json({ ok });
});
