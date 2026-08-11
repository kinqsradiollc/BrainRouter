/**
 * Planner persistence (migrations 051/058/059).
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
import type { PoolClient } from "pg";
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
  updatedAt: { physical: number; logical: number; deviceId: string };
  deletedAt: { physical: number; logical: number; deviceId: string } | null;
}

export interface PlannerOperationReceipt {
  itemId: string;
  entity: "item" | "block" | null;
  operationKind: string | null;
  fingerprint: string | null;
}

export interface PlannerMutationQueries {
  getPlannerItem(orgId: string, userId: string, id: string): Promise<PlannerItemRow | null>;
  upsertPlannerItem(
    orgId: string,
    userId: string,
    item: Parameters<typeof upsertPlannerItem>[3],
  ): Promise<PlannerItemRow>;
  getPlannerBlock(orgId: string, userId: string, id: string): Promise<PlannerBlockRow | null>;
  upsertPlannerBlock(orgId: string, userId: string, block: PlannerBlockRow): Promise<PlannerBlockRow>;
  tombstonePlannerBlocksForItem(
    orgId: string,
    userId: string,
    itemId: string,
    deletedAt: PlannerBlockRow["updatedAt"],
  ): Promise<number>;
  getOperationReceipt(orgId: string, userId: string, key: string): Promise<PlannerOperationReceipt | null>;
  recordOperationApplied(
    orgId: string,
    userId: string,
    key: string,
    itemId: string,
    entity: "item" | "block",
    operationKind: string,
    fingerprint: string,
  ): Promise<void>;
}

function clientExecutor(client: PoolClient): Executor {
  return {
    rows: async (text, params) => (await client.query(text, params)).rows,
    one: async (text, params) => (await client.query(text, params)).rows[0] ?? null,
    run: async (text, params) => (await client.query(text, params)).rowCount ?? 0,
    // The callback already owns the transaction and must stay on this client.
    tx: async (fn) => fn(client),
  };
}

function mutationQueries(
  exec: Executor,
  lockedOrgId: string,
  lockedUserId: string,
): PlannerMutationQueries {
  const assertScope = (orgId: string, userId: string): void => {
    if (orgId !== lockedOrgId || userId !== lockedUserId) {
      throw new Error("A planner mutation cannot change organization or user scope inside its transaction.");
    }
  };
  return {
    getPlannerItem: (orgId, userId, id) => {
      assertScope(orgId, userId);
      return getPlannerItem(exec, orgId, userId, id);
    },
    upsertPlannerItem: (orgId, userId, item) => {
      assertScope(orgId, userId);
      return upsertPlannerItem(exec, orgId, userId, item);
    },
    getPlannerBlock: (orgId, userId, id) => {
      assertScope(orgId, userId);
      return getPlannerBlock(exec, orgId, userId, id);
    },
    upsertPlannerBlock: (orgId, userId, block) => {
      assertScope(orgId, userId);
      return upsertPlannerBlock(exec, orgId, userId, block);
    },
    tombstonePlannerBlocksForItem: (orgId, userId, itemId, deletedAt) => {
      assertScope(orgId, userId);
      return tombstonePlannerBlocksForItem(exec, orgId, userId, itemId, deletedAt);
    },
    getOperationReceipt: (orgId, userId, key) => {
      assertScope(orgId, userId);
      return getOperationReceipt(exec, orgId, userId, key);
    },
    recordOperationApplied: (orgId, userId, key, itemId, entity, operationKind, fingerprint) => {
      assertScope(orgId, userId);
      return recordOperationApplied(
        exec, orgId, userId, key, itemId, entity, operationKind, fingerprint,
      );
    },
  };
}

/**
 * Serialize one person's planner mutations and keep the read/merge/write plus
 * idempotency receipt on one transaction snapshot. A user-level lock also
 * makes parent deletion atomic with block creation; the org/user components
 * ensure unrelated people never contend or cross scope.
 */
export function withPlannerMutation<T>(
  exec: Executor,
  orgId: string,
  userId: string,
  fn: (queries: PlannerMutationQueries) => Promise<T>,
): Promise<T> {
  return exec.tx(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify(["brainrouter:planner", orgId, userId])],
    );
    const locked = clientExecutor(client);
    return fn(mutationQueries(locked, orgId, userId));
  });
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
export async function getOperationReceipt(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
): Promise<PlannerOperationReceipt | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT item_id, entity, operation_kind, operation_fingerprint
       FROM planner_applied_operations
      WHERE org_id = $1 AND user_id = $2 AND idempotency_key = $3`,
    [orgId, userId, key],
  );
  return row ? {
    itemId: String(row.item_id),
    entity: row.entity === "item" || row.entity === "block" ? row.entity : null,
    operationKind: row.operation_kind == null ? null : String(row.operation_kind),
    fingerprint: row.operation_fingerprint == null ? null : String(row.operation_fingerprint),
  } : null;
}

export async function recordOperationApplied(
  exec: Executor,
  orgId: string,
  userId: string,
  key: string,
  itemId: string,
  entity: "item" | "block",
  operationKind: string,
  fingerprint: string,
): Promise<void> {
  await exec.run(
    `INSERT INTO planner_applied_operations
       (org_id, user_id, idempotency_key, item_id, entity, operation_kind, operation_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (org_id, user_id, idempotency_key) DO NOTHING`,
    [orgId, userId, key, itemId, entity, operationKind, fingerprint],
  );
}

/* -------------------------------------------------------------------- blocks */

function toBlockRow(r: Record<string, unknown>): PlannerBlockRow {
  const rawHlc = typeof r.updated_at_hlc === "string"
    ? JSON.parse(r.updated_at_hlc) as Record<string, unknown>
    : (r.updated_at_hlc ?? {}) as Record<string, unknown>;
  const rawDeletedAt = typeof r.deleted_at_hlc === "string"
    ? JSON.parse(r.deleted_at_hlc) as Record<string, unknown>
    : r.deleted_at_hlc == null ? null : r.deleted_at_hlc as Record<string, unknown>;
  return {
    id: String(r.id),
    itemId: String(r.item_id),
    scheduledFor: r.scheduled_for ? new Date(String(r.scheduled_for)).toISOString() : null,
    estimateMinutes: Number(r.estimate_minutes),
    actualMinutes: r.actual_minutes == null ? null : Number(r.actual_minutes),
    carriedOver: Number(r.carried_over ?? 0),
    completedAt: r.completed_at ? new Date(String(r.completed_at)).toISOString() : null,
    revision: String(r.revision),
    updatedAt: {
      physical: Number(rawHlc.physical ?? 0),
      logical: Number(rawHlc.logical ?? 0),
      deviceId: String(rawHlc.deviceId ?? "server"),
    },
    deletedAt: rawDeletedAt ? {
      physical: Number(rawDeletedAt.physical ?? 0),
      logical: Number(rawDeletedAt.logical ?? 0),
      deviceId: String(rawDeletedAt.deviceId ?? "server"),
    } : null,
  };
}

export async function listPlannerBlocks(
  exec: Executor,
  orgId: string,
  userId: string,
): Promise<PlannerBlockRow[]> {
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, item_id, scheduled_for, estimate_minutes, actual_minutes,
            carried_over, completed_at, revision, updated_at_hlc, deleted_at_hlc
       FROM planner_blocks
      WHERE org_id = $1 AND user_id = $2 AND deleted_at_hlc IS NULL
      ORDER BY scheduled_for NULLS LAST, revision ASC
      LIMIT 1000`,
    [orgId, userId],
  );
  return rows.map(toBlockRow);
}

/**
 * Block changes for sync. Blocks use their own revision sequence, so they need
 * their own cursor component rather than being replayed in full on every item
 * pull. The same 1000-row page bound as items prevents one response from
 * growing with a user's entire scheduling history.
 */
export async function listPlannerBlocksSince(
  exec: Executor,
  orgId: string,
  userId: string,
  since?: string,
): Promise<PlannerBlockRow[]> {
  const cursor = since && /^\d+$/.test(since) ? since : "0";
  const rows = await exec.rows<Record<string, unknown>>(
    `SELECT id, item_id, scheduled_for, estimate_minutes, actual_minutes,
            carried_over, completed_at, revision, updated_at_hlc, deleted_at_hlc
       FROM planner_blocks
      WHERE org_id = $1 AND user_id = $2 AND revision > $3
      ORDER BY revision ASC
      LIMIT 1000`,
    [orgId, userId, cursor],
  );
  return rows.map(toBlockRow);
}

export async function getPlannerBlock(
  exec: Executor,
  orgId: string,
  userId: string,
  id: string,
): Promise<PlannerBlockRow | null> {
  const row = await exec.one<Record<string, unknown>>(
    `SELECT id, item_id, scheduled_for, estimate_minutes, actual_minutes,
            carried_over, completed_at, revision, updated_at_hlc, deleted_at_hlc
       FROM planner_blocks
      WHERE org_id = $1 AND user_id = $2 AND id = $3`,
    [orgId, userId, id],
  );
  return row ? toBlockRow(row) : null;
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
        actual_minutes, carried_over, completed_at, updated_at_hlc, deleted_at_hlc, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, now())
     ON CONFLICT (org_id, user_id, id) DO UPDATE SET
       scheduled_for    = EXCLUDED.scheduled_for,
       estimate_minutes = EXCLUDED.estimate_minutes,
       actual_minutes   = EXCLUDED.actual_minutes,
       carried_over     = EXCLUDED.carried_over,
       completed_at     = EXCLUDED.completed_at,
       updated_at_hlc   = EXCLUDED.updated_at_hlc,
       deleted_at_hlc   = EXCLUDED.deleted_at_hlc,
       revision         = nextval(pg_get_serial_sequence('planner_blocks', 'revision')),
       updated_at       = now()
     RETURNING id, item_id, scheduled_for, estimate_minutes, actual_minutes,
               carried_over, completed_at, revision, updated_at_hlc, deleted_at_hlc`,
    [
      orgId, userId, block.id, block.itemId, block.scheduledFor,
      block.estimateMinutes, block.actualMinutes, block.carriedOver, block.completedAt,
      JSON.stringify(block.updatedAt),
      block.deletedAt ? JSON.stringify(block.deletedAt) : null,
    ],
  );
  return toBlockRow(row!);
}

/** Tombstone every child in the same transaction as its parent deletion. */
export async function tombstonePlannerBlocksForItem(
  exec: Executor,
  orgId: string,
  userId: string,
  itemId: string,
  deletedAt: PlannerBlockRow["updatedAt"],
): Promise<number> {
  const stamp = JSON.stringify(deletedAt);
  return exec.run(
    `UPDATE planner_blocks
        SET deleted_at_hlc = $4::jsonb,
            updated_at_hlc = $4::jsonb,
            revision = nextval(pg_get_serial_sequence('planner_blocks', 'revision')),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2 AND item_id = $3
        AND deleted_at_hlc IS DISTINCT FROM $4::jsonb`,
    [orgId, userId, itemId, stamp],
  );
}

/**
 * Retention sweep (D8 → ADR-027 D11).
 *
 * Completed items older than the window are rebuilt from an explicit allowlist.
 * This is data minimisation, not field subtraction: a newly-added source field
 * must not accidentally become permanent history merely because this sweep did
 * not know to delete it. The estimate and its HLC survive so cross-device drift
 * calculations can still order that value correctly.
 */
export async function compactCompletedPlannerItems(
  exec: Executor,
  orgId: string,
  userId: string,
  retentionDays: number,
): Promise<number> {
  return exec.run(
    `UPDATE planner_items
        SET payload_json = jsonb_strip_nulls(jsonb_build_object(
              'id', payload_json->'id',
              'origin', payload_json->'origin',
              'title', payload_json->'title',
              'completed', payload_json->'completed',
              'estimateMinutes', payload_json->'estimateMinutes',
              'estimateUpdatedAt', payload_json->'estimateUpdatedAt'
            )),
            revision = nextval(pg_get_serial_sequence('planner_items', 'revision')),
            updated_at = now()
      WHERE org_id = $1 AND user_id = $2
        AND completed = true
        AND updated_at < now() - make_interval(days => $3)
        AND payload_json <> jsonb_strip_nulls(jsonb_build_object(
              'id', payload_json->'id',
              'origin', payload_json->'origin',
              'title', payload_json->'title',
              'completed', payload_json->'completed',
              'estimateMinutes', payload_json->'estimateMinutes',
              'estimateUpdatedAt', payload_json->'estimateUpdatedAt'
            ))`,
    [orgId, userId, retentionDays],
  );
}
