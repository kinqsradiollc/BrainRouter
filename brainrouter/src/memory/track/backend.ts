/**
 * Track backend — the data plane behind /api/track. Org-scoped, collaborative work
 * items (migration 034). Track used to be a local per-workspace `track.json` that
 * couldn't sync across surfaces; this gives it a shared home so a meeting→Track
 * action creates a REAL, viewable item and done/untrack sync on desktop + dashboard.
 */
import { randomUUID } from "node:crypto";
import { memoryEngine } from "../engine.js";
import type {
  CreateTrackItemInput, TrackItemRow, TrackStatusCategory, UpdateTrackItemPatch,
} from "../store/postgres/queries/trackQueries.js";

interface TrackStore {
  createTrackItem(input: CreateTrackItemInput): Promise<TrackItemRow>;
  listTrackItems(orgId: string, opts?: { includeArchived?: boolean; limit?: number }): Promise<TrackItemRow[]>;
  getTrackItem(orgId: string, id: string): Promise<TrackItemRow | null>;
  getTrackItemBySourceRef(orgId: string, sourceRef: string): Promise<TrackItemRow | null>;
  transitionTrackItem(orgId: string, id: string, status: string, statusCategory: TrackStatusCategory): Promise<TrackItemRow | null>;
  updateTrackItem(orgId: string, id: string, patch: UpdateTrackItemPatch): Promise<TrackItemRow | null>;
  deleteTrackItem(orgId: string, id: string): Promise<boolean>;
}
const store = (): TrackStore => memoryEngine.store as unknown as TrackStore;

export type { TrackItemRow, TrackStatusCategory, UpdateTrackItemPatch } from "../store/postgres/queries/trackQueries.js";

export interface CreateTrackInput {
  title: string;
  description?: string;
  type?: string;
  status?: string;
  statusCategory?: TrackStatusCategory;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  source?: "manual" | "meeting-action";
  sourceRef?: string | null;
}

const MAX_TITLE = 500;

export async function listTrack(orgId: string, includeArchived = false): Promise<TrackItemRow[]> {
  return store().listTrackItems(orgId, { includeArchived });
}

export async function getTrack(orgId: string, id: string): Promise<TrackItemRow | null> {
  return store().getTrackItem(orgId, id);
}

export async function createTrack(orgId: string, userId: string, input: CreateTrackInput): Promise<TrackItemRow> {
  const title = (input.title ?? "").trim().slice(0, MAX_TITLE);
  if (!title) throw new Error("Track item title is required");
  // Idempotent for meeting-sourced items: a sourceRef maps to exactly one item, so
  // re-tracking the same meeting action returns the existing item (no duplicates).
  if (input.sourceRef) {
    const existing = await store().getTrackItemBySourceRef(orgId, input.sourceRef);
    if (existing) return existing;
  }
  return store().createTrackItem({
    id: `wi_${randomUUID()}`,
    orgId, userId, title,
    description: input.description,
    type: input.type,
    status: input.status,
    statusCategory: input.statusCategory,
    priority: input.priority,
    assignee: input.assignee ?? null,
    labels: input.labels,
    source: input.source ?? "manual",
    sourceRef: input.sourceRef ?? null,
  });
}

export async function transitionTrack(orgId: string, id: string, status: string, statusCategory: TrackStatusCategory): Promise<TrackItemRow | null> {
  return store().transitionTrackItem(orgId, id, status, statusCategory);
}

export async function updateTrack(orgId: string, id: string, patch: UpdateTrackItemPatch): Promise<TrackItemRow | null> {
  return store().updateTrackItem(orgId, id, patch);
}

export async function deleteTrack(orgId: string, id: string): Promise<boolean> {
  return store().deleteTrackItem(orgId, id);
}

/** Untrack a meeting action — remove the item created for its sourceRef. Returns the
 *  removed item's id (so the caller can clear the meeting's trackItemId), or null. */
export async function untrackBySourceRef(orgId: string, sourceRef: string): Promise<string | null> {
  const existing = await store().getTrackItemBySourceRef(orgId, sourceRef);
  if (!existing) return null;
  const removed = await store().deleteTrackItem(orgId, existing.id);
  return removed ? existing.id : null;
}
