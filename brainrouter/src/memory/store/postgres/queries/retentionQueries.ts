/**
 * ADR-027 D11 / P1-6 — retention and compaction.
 *
 * Rung one of the growth ladder: most growth is append-forever data nobody
 * reads after a week. Summarize the old detail into compact records and drop
 * the raw rows, before reaching for indexes, partitioning, or sharding.
 *
 * Owner decision: 90 days of DETAIL, then compact.
 *
 * Two properties every pass here holds to:
 *
 *   - ATOMIC. Aggregation and deletion happen in ONE statement (a CTE whose
 *     `DELETE ... RETURNING` feeds the `INSERT ... ON CONFLICT`), so there is no
 *     window in which rows are deleted but not yet counted. A crash between two
 *     separate statements would silently lose usage.
 *   - BATCHED. Each call bounds its own work, so a large backlog drains over
 *     several passes instead of taking a long lock on a hot table. A long
 *     retention transaction is exactly what pins the cleanup horizon and
 *     degrades the queue sharing this database.
 */

import type { Executor } from "./executor.js";
import { compactCompletedPlannerItems } from "./plannerQueries.js";

/** Owner-approved default: keep full detail this long, then compact. */
export const DEFAULT_RETENTION_DAYS = 90;

/** Bound on rows touched per pass, so retention never holds a long lock. */
const DEFAULT_BATCH = 5_000;

export interface RetentionOptions {
  retentionDays?: number;
  batchSize?: number;
}

function resolve(options?: RetentionOptions): { days: number; batch: number } {
  const days = Math.max(1, Math.floor(options?.retentionDays ?? DEFAULT_RETENTION_DAYS));
  const batch = Math.min(Math.max(1, Math.floor(options?.batchSize ?? DEFAULT_BATCH)), 50_000);
  return { days, batch };
}

/**
 * Fold expired `model_usage_events` into `model_usage_daily`.
 *
 * The table is metadata-only and everything asked of it beyond the recent
 * window is an aggregate, so the raw rows are droppable without losing a
 * reported number. Returns how many raw rows were folded.
 *
 * The whole thing is one statement on purpose: `moved` deletes and returns the
 * batch, and the aggregate is computed from what was actually deleted. Splitting
 * it would open a window where a crash loses usage permanently.
 */
export async function rollUpModelUsage(exec: Executor, options?: RetentionOptions): Promise<number> {
  const { days, batch } = resolve(options);
  // The count comes from a trailing SELECT over `moved`, NOT from the
  // statement's row count. A data-modifying CTE reports the row count of the
  // FINAL statement — here the INSERT — which is the number of aggregate GROUPS,
  // not the number of raw rows folded. Ten requests on one model in one day
  // would report 1, so a batch-drain loop would stop early and the log would
  // understate what happened. Postgres runs every data-modifying CTE whether or
  // not the main query references it, so `rolled` still performs the insert.
  const row = await exec.one<{ folded: number }>(
    `WITH expired AS (
       SELECT id FROM model_usage_events
        WHERE created_at < now() - make_interval(days => $1::int)
        ORDER BY id
        LIMIT $2::int
        FOR UPDATE SKIP LOCKED
     ), moved AS (
       DELETE FROM model_usage_events
        WHERE id IN (SELECT id FROM expired)
       RETURNING created_at, org_id, public_model_id, input_tokens, output_tokens,
                 cached_input_tokens, total_tokens, cost_microusd
     ), rolled AS (
       INSERT INTO model_usage_daily AS d
         (day, org_id, public_model_id, requests, input_tokens, output_tokens,
          cached_input_tokens, total_tokens, cost_microusd)
       SELECT (created_at AT TIME ZONE 'UTC')::date, org_id, public_model_id,
              count(*),
              COALESCE(sum(input_tokens), 0),
              COALESCE(sum(output_tokens), 0),
              COALESCE(sum(cached_input_tokens), 0),
              COALESCE(sum(total_tokens), 0),
              COALESCE(sum(cost_microusd), 0)
         FROM moved
        GROUP BY 1, 2, 3
       ON CONFLICT (day, org_id, public_model_id) DO UPDATE SET
         requests            = d.requests + EXCLUDED.requests,
         input_tokens        = d.input_tokens + EXCLUDED.input_tokens,
         output_tokens       = d.output_tokens + EXCLUDED.output_tokens,
         cached_input_tokens = d.cached_input_tokens + EXCLUDED.cached_input_tokens,
         total_tokens        = d.total_tokens + EXCLUDED.total_tokens,
         cost_microusd       = d.cost_microusd + EXCLUDED.cost_microusd
       RETURNING 1
     )
     SELECT count(*)::int AS folded FROM moved`,
    [days, batch],
  );
  return Number(row?.folded ?? 0);
}

/**
 * Compact the progress timeline of terminal jobs past the retention window.
 *
 * The job ROW cannot be deleted — `repository_assurance_runs.job_id` references
 * it `ON DELETE RESTRICT` — and its input/output are small and occasionally
 * still read. `progress_json` is where the bytes are: a long pentest or review
 * accumulates hundreds of events that exist purely for live dashboard polling
 * and are of no interest months later.
 *
 * The timeline collapses to a single marker event that records what was there,
 * so the row still reads as a coherent (if summarized) history rather than
 * appearing to have never run. Returns how many jobs were compacted.
 */
export async function compactJobProgress(exec: Executor, options?: RetentionOptions): Promise<number> {
  const { days, batch } = resolve(options);
  return exec.run(
    `WITH expired AS (
       SELECT id FROM memory_jobs
        WHERE status IN ('done', 'failed', 'cancelled')
          AND updated_at::timestamptz < now() - make_interval(days => $1::int)
          AND progress_json IS NOT NULL
          AND jsonb_typeof(progress_json::jsonb) = 'array'
          AND jsonb_array_length(progress_json::jsonb) > 1
        ORDER BY updated_at
        LIMIT $2::int
        FOR UPDATE SKIP LOCKED
     )
     UPDATE memory_jobs SET progress_json = jsonb_build_array(
       jsonb_build_object(
         'ts', COALESCE(progress_json::jsonb -> -1 ->> 'ts', updated_at),
         'kind', 'compacted',
         'msg', jsonb_array_length(progress_json::jsonb)
                || ' progress events compacted after ' || $1::int || ' days',
         'data', jsonb_build_object(
           'originalEvents', jsonb_array_length(progress_json::jsonb),
           'firstTs', progress_json::jsonb -> 0 ->> 'ts'
         )
       )
     )::text
      WHERE id IN (SELECT id FROM expired)`,
    [days, batch],
  );
}

/**
 * ADR-028 D8 — run the planner's own compaction as part of this pass.
 *
 * `compactCompletedPlannerItems` is scoped to one `(org_id, user_id)`, because a
 * planner is personal and the user is part of the KEY rather than a column
 * anybody could forget in a WHERE clause. That scoping is right, and it is why
 * this wrapper exists: a retention pass is global, so it finds the tenants with
 * expired completed items and sweeps each one, instead of a second global
 * statement drifting from the per-user one the sync path already tests.
 *
 * Bounded the same way as its siblings — the tenant list is capped per pass, so
 * a large install drains over several hours instead of holding one long lock.
 * Returns how many item rows were minimised.
 */
export async function compactPlannerItems(exec: Executor, options?: RetentionOptions): Promise<number> {
  const { days, batch } = resolve(options);
  const tenants = await exec.rows<{ org_id: string; user_id: string }>(
    `SELECT DISTINCT org_id, user_id
       FROM planner_items
      WHERE completed = true
        AND updated_at < now() - make_interval(days => $1::int)
      LIMIT $2::int`,
    [days, batch],
  );
  let compacted = 0;
  for (const tenant of tenants) {
    compacted += await compactCompletedPlannerItems(exec, tenant.org_id, tenant.user_id, days);
  }
  return compacted;
}

export interface RetentionPassResult {
  usageEventsFolded: number;
  jobsCompacted: number;
  plannerItemsCompacted: number;
}

/**
 * One bounded retention pass. Best-effort by construction: a failure in any
 * part is reported but never propagated, because retention must not be able to
 * break the job drain it runs alongside.
 */
export async function runRetentionPass(exec: Executor, options?: RetentionOptions): Promise<RetentionPassResult> {
  let usageEventsFolded = 0;
  let jobsCompacted = 0;
  let plannerItemsCompacted = 0;
  try {
    usageEventsFolded = await rollUpModelUsage(exec, options);
  } catch (err: any) {
    console.error("[BrainRouter] usage rollup failed:", err?.message ?? err);
  }
  try {
    jobsCompacted = await compactJobProgress(exec, options);
  } catch (err: any) {
    console.error("[BrainRouter] job-progress compaction failed:", err?.message ?? err);
  }
  try {
    plannerItemsCompacted = await compactPlannerItems(exec, options);
  } catch (err: any) {
    console.error("[BrainRouter] planner compaction failed:", err?.message ?? err);
  }
  return { usageEventsFolded, jobsCompacted, plannerItemsCompacted };
}
