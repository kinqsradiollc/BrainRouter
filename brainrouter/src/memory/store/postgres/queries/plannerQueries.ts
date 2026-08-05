/**
 * Planner persistence (migration 051).
 *
 * ADR-028 D9: keyed by `(org_id, user_id, id)`. A planner is personal, so the
 * user is part of the KEY rather than an author column — cross-user reads are
 * impossible by construction rather than by a WHERE clause somebody might
 * forget. Every function below takes both, and none of them accepts a user id
 * from anywhere but the authenticated session.
 *
 * The item payload is jsonb because D4 resolves LWW per FIELD, so each field
 * carries its own HLC stamp. Modelling that as columns would mean a stamp
 * column beside every value column, and the merge functions in core already
 * speak the object shape.
 */
import type { Executor } from "./executor.js";

export interface PlannerItemRow {
  id: string;
  origin: "owned" | "mirrored";
  source: string | null;
  payload: Record<string, unknown>;
  revision: string;
  updatedAt: string;
}

export interface PlannerBlockRow {
  id: string;
  itemId: string;
  scheduledFor: string | null;
  estimateMinutes: number;
  actualMinutes: number | null;
  carriedOver: number;
  completedAt: string | null;
  revision: string;
}

function toItemRow(r: Record<string, unknown>): PlannerItemRow {
  return {
    id: String(r.id),
    origin: r.origin === "mirrored" ? "mirrored" : "owned",
    source: r.source == null ? null : String(r.source),
    payload: (r.payload_json ?? {}) as Record<string, unknown>,
    revision: String(r.revision),
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

/**
 * Changes since a client cursor.
 *
 * Ordered by `revision`, and the cursor IS a revision rather than a timestamp:
 * two rows written in the same millisecond are indistinguishable by time, so a
 * client resuming on a timestamp boundary silently skips whichever sorted
 * second. This is the same reasoning D3 gives for not ordering by wall clock.
 */
export async function listPlannerItemsSince(
  exec: Executor,
  orgId: string,
  userId: string,
  since?: string,
): Promise<PlannerItemRow[]> {
  const cursor = since && /^\d+$/.test(since) ? since : "0";
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, origin, source, payload_json, revision, updated_at
       FROM planner_items
      WHERE org_id = $1 AND user_id = $2 AND revision > $3
      ORDER BY revision ASC
      LIMIT 1000`,
    [orgId, userId, cursor],
  );
  return rows.map(toItemRow);
}

export async function getPlannerItem(
  exec: Executor,
  orgId: string,
  userId: string,
  id: string,
): Promise<PlannerItemRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT id, origin, source, payload_json, revision, updated_at
       FROM planner_items
      WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, userId, id],
  );
  return row ? toItemRow(row) : null;
}

/**
 * Insert or replace an item.
 *
 * `revision` is bumped by the sequence default on insert; on update it is set
 * explicitly from `nextval`, because a client's `changed-since` pull would
 * otherwise never see an update — the row would keep the revision it was
 * created with, and every device except the writer would stay stale forever.
 */
export async function upsertPlannerItem(
  exec: Executor,
  orgId: string,
  userId: string,
  item: {
    id: string;
    origin: "owned" | "mirrored";
    source?: string | null;
    payload: Record<string, unknown>;
    dueDate?: string | null;
    completed?: boolean;
    deletedAtHlc?: string | null;
  },
): Promise<PlannerItemRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO planner_items
       (org_id, user_id, id, origin, source, payload_json, due_date, completed, deleted_at_hlc, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, now())
     ON CONFLICT (org_id, user_id, id) DO UPDATE SET
       origin         = EXCLUDED.origin,
       source         = EXCLUDED.source,
       payload_json   = EXCLUDED.payload_json,
       due_date       = EXCLUDED.due_date,
       completed      = EXCLUDED.completed,
       deleted_at_hlc = EXCLUDED.deleted_at_hlc,
       revision       = nextval(pg_get_serial_sequence('planner_items', 'revision')),
       updated_at     = now()
     RETURNING id, origin, source, payload_json, revision, updated_at`,
    [
      orgId, userId, item.id, item.origin, item.source ?? null,
      JSON.stringify(item.payload),
      item.dueDate ?? null,
      item.completed ?? false,
      item.deletedAtHlc ?? null,
    ],
  );
  return toItemRow(row!);
}

export async function latestPlannerRevision(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<string> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT COALESCE(MAX(revision), 0) AS cursor
       FROM planner_items WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId],
  );
  return String(row?.cursor ?? "0");
}

/* --------------------------------------------------------------- idempotency */

/**
 * Has this operation already been applied?
 *
 * Tenant-scoped, deliberately. Migration 049 fixed a cross-tenant idempotency
 * index in this codebase — a key without a tenant lets one org's operation
 * suppress another's, and the conflict resolution then returns the wrong row.
 * Repeating that shape in a new table would be careless.
 */
export async function wasOperationApplied(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
): Promise<boolean> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT 1 AS present FROM planner_applied_operations
      WHERE org_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [orgId, userId, key],
  );
  return row !== null;
}

export async function recordOperationApplied(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
  itemId: string,
): Promise<void> {
  await exec.run(
    `INSERT INTO planner_applied_operations (org_id, user_id, idempotency_key, item_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING`,
    [orgId, userId, key, itemId],
  );
}

/* -------------------------------------------------------------------- blocks */

function toBlockRow(r: Record<string, unknown>): PlannerBlockRow {
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    scheduledFor: r.scheduled_for ? new Date(String(r.scheduled_for)).toISOString() : null,
    estimateMinutes: Number(r.estimate_minutes),
    actualMinutes: r.actual_minutes == null ? null : Number(r.actual_minutes),
    carriedOver: Number(r.carried_over ?? 0),
    completedAt: r.completed_at ? new Date(String(r.completed_at)).toISOString() : null,
    revision: String(r.revision),
  };
}

export async function listPlannerBlocks(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<PlannerBlockRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, item_id, scheduled_for, estimate_minutes, actual_minutes,
            carried_over, completed_at, revision
       FROM planner_blocks
      WHERE org_id = $1 AND user_id = $2
      ORDER BY scheduled_for NULLS LAST, revision ASC
      LIMIT 1000`,
    [orgId, userId],
  );
  return rows.map(toBlockRow);
}

export async function upsertPlannerBlock(
  exec: Executor,
  orgId: string,
  userId: string,
  block: PlannerBlockRow,
): Promise<PlannerBlockRow> {
  const row = await exec.one<Record<string, unknown>>(
    `INSERT INTO planner_blocks
       (org_id, user_id, id, item_id, scheduled_for, estimate_minutes,
        actual_minutes, carried_over, completed_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (org_id, user_id, id) DO UPDATE SET
       scheduled_for    = EXCLUDED.scheduled_for,
       estimate_minutes = EXCLUDED.estimate_minutes,
       actual_minutes   = EXCLUDED.actual_minutes,
       carried_over     = EXCLUDED.carried_over,
       completed_at     = EXCLUDED.completed_at,
       revision         = nextval(pg_get_serial_sequence('planner_blocks', 'revision')),
       updated_at       = now()
     RETURNING id, item_id, scheduled_for, estimate_minutes, actual_minutes,
               carried_over, completed_at, revision`,
    [
      orgId, userId, block.id, block.itemId, block.scheduledFor,
      block.estimateMinutes, block.actualMinutes, block.carriedOver, block.completedAt,
    ],
  );
  return toBlockRow(row!);
}

/**
 * Retention sweep (D8 → ADR-027 D11).
 *
 * Completed items older than the window keep their title, completion date and
 * estimate-versus-actual, and lose their notes and conflict history. The
 * estimate/actual pair survives because consistent overruns are debt evidence
 * that outlives the notes they came with.
 */
export async function compactCompletedPlannerItems(
  exec: Executor,
  orgId: string,
  userId: string,
  retentionDays: number,
): Promise<number> {
  return exec.run(
    `UPDATE planner_items
        SET payload_json = jsonb_build_object(
              'id',        payload_json->'id',
              'origin',    payload_json->'origin',
              'title',     payload_json->'title',
              'completed', payload_json->'completed'
            ),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2
        AND completed = true
        AND updated_at < now() - make_interval(days => $3)
        AND payload_json ? 'notes'`,
    [orgId, userId, retentionDays],
  );
}
