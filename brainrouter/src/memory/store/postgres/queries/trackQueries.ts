/**
 * Track persistence (migration 034). The `track_items` table is the org-scoped,
 * collaborative home for Track work items — previously a local per-workspace
 * `track.json`, which could not sync across desktop + dashboard. Writes are
 * org-scoped (any member of the org may edit the shared board); cross-org access
 * is impossible because every query is keyed by `org_id`. Exposed via thin
 * PostgresMemoryStore methods, consumed by memory/track/backend.ts.
 */
import type { Executor } from "./executor.js";

export type TrackStatusCategory = "todo" | "in_progress" | "completed";
export type TrackItemSource = "manual" | "meeting-action";

export interface TrackItemRow {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  description: string;
  type: string;
  status: string;
  statusCategory: TrackStatusCategory;
  priority: string;
  assignee: string | null;
  labels: string[];
  source: TrackItemSource;
  sourceRef: string | null;
  completedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTrackItemInput {
  id: string;
  orgId: string;
  userId: string;
  title: string;
  description?: string;
  type?: string;
  status?: string;
  statusCategory?: TrackStatusCategory;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  source?: TrackItemSource;
  sourceRef?: string | null;
}

export interface UpdateTrackItemPatch {
  title?: string;
  description?: string;
  status?: string;
  statusCategory?: TrackStatusCategory;
  priority?: string;
  assignee?: string | null;
  labels?: string[];
  /** ISO timestamp to archive (hide), or null to un-archive. */
  archivedAt?: string | null;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : "";
}
function isoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return iso(value) || null;
}
function isCategory(value: unknown): TrackStatusCategory {
  return value === "in_progress" || value === "completed" ? value : "todo";
}

function mapRow(r: Record<string, unknown>): TrackItemRow {
  let labels: string[] = [];
  try { const parsed = JSON.parse(String(r.labels_json ?? "[]")); if (Array.isArray(parsed)) labels = parsed.filter((x): x is string => typeof x === "string"); } catch { /* keep [] */ }
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    userId: String(r.user_id),
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    type: String(r.type ?? "task"),
    status: String(r.status ?? "todo"),
    statusCategory: isCategory(r.status_category),
    priority: String(r.priority ?? "medium"),
    assignee: r.assignee == null ? null : String(r.assignee),
    labels,
    source: r.source === "meeting-action" ? "meeting-action" : "manual",
    sourceRef: r.source_ref == null ? null : String(r.source_ref),
    completedAt: isoOrNull(r.completed_at),
    archivedAt: isoOrNull(r.archived_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const COLS = `id, org_id, user_id, title, description, type, status, status_category, priority,
  assignee, labels_json, source, source_ref, completed_at, archived_at, created_at, updated_at`;

export async function createTrackItem(exec: Executor, input: CreateTrackItemInput): Promise<TrackItemRow> {
  const category = isCategory(input.statusCategory);
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO track_items
       (id, org_id, user_id, title, description, type, status, status_category, priority,
        assignee, labels_json, source, source_ref, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${COLS}`,
    [
      input.id, input.orgId, input.userId, input.title, input.description ?? "",
      input.type ?? "task", input.status ?? "todo", category, input.priority ?? "medium",
      input.assignee ?? null, JSON.stringify(input.labels ?? []), input.source ?? "manual",
      input.sourceRef ?? null, category === "completed" ? new Date().toISOString() : null,
    ],
  );
  return mapRow(row!);
}

/** Every item in the org (collaborative board), newest first. Archived hidden by default. */
export async function listTrackItems(exec: Executor, orgId: string, opts?: { includeArchived?: boolean; limit?: number }): Promise<TrackItemRow[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 1000);
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT ${COLS} FROM track_items
      WHERE org_id = $1 ${opts?.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY created_at DESC, id DESC LIMIT $2`,
    [orgId, limit],
  );
  return rows.map(mapRow);
}

export async function getTrackItem(exec: Executor, orgId: string, id: string): Promise<TrackItemRow | null> {
  const row = await exec.one<Record<string, unknown>>(`SELECT ${COLS} FROM track_items WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return row ? mapRow(row) : null;
}

export async function getTrackItemBySourceRef(exec: Executor, orgId: string, sourceRef: string): Promise<TrackItemRow | null> {
  const row = await exec.one<Record<string, unknown>>(`SELECT ${COLS} FROM track_items WHERE org_id = $1 AND source_ref = $2`, [orgId, sourceRef]);
  return row ? mapRow(row) : null;
}

/** Move an item to a new status/bucket; `completed_at` is set/cleared by the bucket. */
export async function transitionTrackItem(exec: Executor, orgId: string, id: string, status: string, statusCategory: TrackStatusCategory): Promise<TrackItemRow | null> {
  const category = isCategory(statusCategory);
  const row = await exec.one<Record<string, unknown>>(
    `UPDATE track_items
        SET status = $3, status_category = $4,
            completed_at = CASE WHEN $4 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE org_id = $1 AND id = $2
      RETURNING ${COLS}`,
    [orgId, id, status, category],
  );
  return row ? mapRow(row) : null;
}

/** Partial update. Only provided fields change; `archivedAt: null` un-archives. */
export async function updateTrackItem(exec: Executor, orgId: string, id: string, patch: UpdateTrackItemPatch): Promise<TrackItemRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [orgId, id];
  const add = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };
  if (patch.title !== undefined) add("title", patch.title);
  if (patch.description !== undefined) add("description", patch.description);
  if (patch.priority !== undefined) add("priority", patch.priority);
  if (patch.assignee !== undefined) add("assignee", patch.assignee);
  if (patch.labels !== undefined) add("labels_json", JSON.stringify(patch.labels));
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.statusCategory !== undefined) {
    const category = isCategory(patch.statusCategory);
    add("status_category", category);
    params.push(category); sets.push(`completed_at = CASE WHEN $${params.length} = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END`);
  }
  if (patch.archivedAt !== undefined) add("archived_at", patch.archivedAt);
  if (!sets.length) return getTrackItem(exec, orgId, id);
  const row = await exec.one<Record<string, unknown>>(
    `UPDATE track_items SET ${sets.join(", ")}, updated_at = now() WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
    params,
  );
  return row ? mapRow(row) : null;
}

export async function deleteTrackItem(exec: Executor, orgId: string, id: string): Promise<boolean> {
  const n = await exec.run(`DELETE FROM track_items WHERE org_id = $1 AND id = $2`, [orgId, id]);
  return n > 0;
}
