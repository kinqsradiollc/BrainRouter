/**
 * Memory-jobs queue SQL (BRAIN-P1) — verbatim extraction from
 * `PostgresMemoryStore`. The `JOB_COLUMNS` projection was a private static; it
 * is now a module constant used identically by every job query.
 */

import { randomUUID } from "node:crypto";
import type {
  MemoryJobRecord,
  MemoryJobStatus,
  MemoryJobEnqueueInput,
  MemoryJobListFilters,
  MemoryJobKindAggregate,
} from "@kinqs/brainrouter-types";
import { jobRowToRecord, asNumber, pg } from "../converters.js";
import type { Executor } from "./executor.js";

const JOB_COLUMNS =
  "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at";

export async function enqueueMemoryJob(exec: Executor, input: MemoryJobEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<MemoryJobRecord> {
  const now = options?.now ?? new Date().toISOString();
  const id = (options?.idGenerator ?? (() => randomUUID()))();
  await exec.run(
    `INSERT INTO memory_jobs (id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, error, created_at, updated_at)
     VALUES ($1,$2,'pending',$3,0,$4,$5,NULL,$6,$7,NULL,NULL,$8,$9)`,
    [id, input.kind, input.priority ?? 50, input.maxAttempts ?? 3, input.runAfter ?? now, input.parentJobId ?? null, JSON.stringify(input.input ?? {}), now, now],
  );
  return (await getMemoryJob(exec, id))!;
}

export async function getMemoryJob(exec: Executor, id: string): Promise<MemoryJobRecord | null> {
  const row = await exec.one(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [id]);
  return row ? jobRowToRecord(row as any) : null;
}

export async function listMemoryJobs(exec: Executor, filters?: MemoryJobListFilters): Promise<MemoryJobRecord[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (filters?.kind) { where.push("kind = ?"); params.push(filters.kind); }
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
  }
  params.push(filters?.limit ?? 100);
  const rows = await exec.rows(
    pg(`SELECT ${JOB_COLUMNS} FROM memory_jobs
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`),
    params,
  );
  return rows.map((r) => jobRowToRecord(r as any));
}

/**
 * ADR-017 D5 — recent PR-review jobs (security + code-review lenses) for an org's
 * Reviews dashboard. The org lives in `input_json` (memory_jobs has no org column);
 * ordered newest-first for display (the queue's default ASC ordering is for draining).
 */
export async function listReviewJobsForOrg(exec: Executor, orgId: string, limit = 30): Promise<MemoryJobRecord[]> {
  const rows = await exec.rows(
    pg(`SELECT ${JOB_COLUMNS} FROM memory_jobs
          WHERE kind IN ('pr-security-review','pr-code-review')
            AND (input_json::jsonb ->> 'orgId') = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`),
    [orgId, limit],
  );
  return rows.map((r) => jobRowToRecord(r as any));
}

export async function claimNextMemoryJob(exec: Executor, options?: { now?: string }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  return exec.tx(async (client) => {
    const sel = await client.query<{ id: string }>(
      `SELECT id FROM memory_jobs
        WHERE status = 'pending' AND run_after <= $1
        ORDER BY priority DESC, run_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [now],
    );
    const candidate = sel.rows[0];
    if (!candidate) return null;
    await client.query(
      "UPDATE memory_jobs SET status = 'running', locked_at = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
      [now, now, candidate.id],
    );
    const row = (await client.query(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [candidate.id])).rows[0];
    return row ? jobRowToRecord(row as any) : null;
  });
}

export async function startMemoryJob(exec: Executor, id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  const changed = await exec.run(
    "UPDATE memory_jobs SET status = 'running', locked_at = $1, updated_at = $2 WHERE id = $3 AND status = 'pending'",
    [now, now, id],
  );
  if (changed === 0) return null;
  return getMemoryJob(exec, id);
}

export async function completeMemoryJob(exec: Executor, id: string, output: unknown, options?: { now?: string }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  const changed = await exec.run(
    "UPDATE memory_jobs SET status = 'done', output_json = $1, error = NULL, locked_at = NULL, updated_at = $2 WHERE id = $3 AND status = 'running'",
    [JSON.stringify(output ?? null), now, id],
  );
  if (changed === 0) return null;
  return getMemoryJob(exec, id);
}

export async function failMemoryJob(exec: Executor, id: string, error: string, options?: { now?: string; backoffMs?: number }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  const job = await getMemoryJob(exec, id);
  if (!job || job.status !== "running") return null;
  const attempts = job.attempts + 1;
  if (attempts < job.maxAttempts) {
    const runAfter = new Date(Date.parse(now) + (options?.backoffMs ?? 0)).toISOString();
    await exec.run(
      "UPDATE memory_jobs SET status = 'pending', attempts = $1, error = $2, run_after = $3, locked_at = NULL, updated_at = $4 WHERE id = $5",
      [attempts, error, runAfter, now, id],
    );
  } else {
    await exec.run(
      "UPDATE memory_jobs SET status = 'failed', attempts = $1, error = $2, locked_at = NULL, updated_at = $3 WHERE id = $4",
      [attempts, error, now, id],
    );
  }
  return getMemoryJob(exec, id);
}

export async function retryMemoryJob(exec: Executor, id: string, options?: { now?: string }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  await exec.run(
    "UPDATE memory_jobs SET status = 'pending', attempts = 0, run_after = $1, locked_at = NULL, error = NULL, updated_at = $2 WHERE id = $3 AND status IN ('failed', 'cancelled')",
    [now, now, id],
  );
  return getMemoryJob(exec, id);
}

export async function cancelMemoryJob(exec: Executor, id: string, options?: { now?: string; reason?: string }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  await exec.run(
    "UPDATE memory_jobs SET status = 'cancelled', error = COALESCE($1, error), locked_at = NULL, updated_at = $2 WHERE id = $3 AND status IN ('pending', 'running')",
    [options?.reason ?? null, now, id],
  );
  return getMemoryJob(exec, id);
}

export async function sweepStuckMemoryJobs(exec: Executor, stuckMs: number, options?: { now?: string }): Promise<number> {
  const now = options?.now ?? new Date().toISOString();
  const cutoff = new Date(Date.parse(now) - stuckMs).toISOString();
  return exec.run(
    "UPDATE memory_jobs SET status = 'cancelled', error = 'swept: lock expired', locked_at = NULL, updated_at = $1 WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < $2",
    [now, cutoff],
  );
}

export async function getMemoryJobKindAggregates(exec: Executor, options?: { now?: string }): Promise<MemoryJobKindAggregate[]> {
  const now = options?.now ?? new Date().toISOString();
  const since24h = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString();
  const kinds = (await exec.rows<{ kind: string }>("SELECT DISTINCT kind FROM memory_jobs ORDER BY kind ASC")).map((r) => r.kind);
  const out: MemoryJobKindAggregate[] = [];
  for (const kind of kinds) {
    const latest = await exec.one<{ status: string; updated_at: string }>(
      "SELECT status, updated_at FROM memory_jobs WHERE kind = $1 ORDER BY updated_at DESC, id DESC LIMIT 1", [kind],
    );
    const lastCompleted = await exec.one<{ updated_at: string }>(
      "SELECT updated_at FROM memory_jobs WHERE kind = $1 AND status = 'done' ORDER BY updated_at DESC LIMIT 1", [kind],
    );
    const pending = await exec.one<{ n: string }>("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = $1 AND status = 'pending'", [kind]);
    const terminal = await exec.one<{ done: string | null; failed: string | null }>(
      `SELECT SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM memory_jobs WHERE kind = $1 AND updated_at >= $2 AND status IN ('done','failed')`,
      [kind, since24h],
    );
    const done = asNumber(terminal?.done);
    const failed = asNumber(terminal?.failed);
    const total = done + failed;
    out.push({
      kind,
      lastStatus: (latest?.status ?? "pending") as MemoryJobStatus,
      lastCompletedAt: lastCompleted?.updated_at ?? null,
      pendingJobs: asNumber(pending?.n),
      successRate24h: total > 0 ? done / total : null,
    });
  }
  return out;
}
