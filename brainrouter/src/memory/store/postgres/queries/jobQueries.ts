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
  MemoryJobProgressEvent,
} from "@kinqs/brainrouter-types";
import { jobRowToRecord, asNumber, pg } from "../converters.js";
import type { Executor } from "./executor.js";

const JOB_COLUMNS =
  "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, progress_json, error, created_at, updated_at";

const REVIEW_JOB_KINDS = "'pr-security-review','pr-code-review','pr-pentest'";
const REVIEW_ALL_KINDS = `${REVIEW_JOB_KINDS},'domain-pentest'`;

export interface ReviewFindingCursor {
  createdAt: string;
  reviewId: string;
  ordinal: number;
}

export interface ReviewFindingQuery {
  limit?: number;
  severity?: string;
  repo?: string;
  status?: string;
  search?: string;
  cursor?: ReviewFindingCursor;
  sort?: "newest" | "oldest";
}

export interface ReviewFindingRow {
  reviewId: string;
  lens: "security" | "code" | "pentest";
  reviewStatus: string;
  repo: string | null;
  prNumber: number | null;
  issueStatus: string;
  ordinal: number;
  finding: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  total: number;
  severityCounts: { critical: number; high: number; medium: number; low: number; info: number };
}

/**
 * Resolve the queue tenant for a job from its input payload: the org owns review
 * jobs (`orgId`), the user owns maintenance jobs (`userId`). Computed in JS at
 * insert time so the fair-scheduling column never depends on a JSON expression.
 * A job with neither is tenant-less (NULL) — exempt from the per-tenant cap.
 */
export function tenantForJobInput(input: unknown): string | null {
  if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    const org = rec.orgId;
    if (typeof org === "string" && org.trim() !== "") return org;
    const user = rec.userId;
    if (typeof user === "string" && user.trim() !== "") return user;
  }
  return null;
}

export async function enqueueMemoryJob(exec: Executor, input: MemoryJobEnqueueInput, options?: { idGenerator?: () => string; now?: string }): Promise<MemoryJobRecord> {
  const now = options?.now ?? new Date().toISOString();
  const id = (options?.idGenerator ?? (() => randomUUID()))();
  await exec.run(
    `INSERT INTO memory_jobs (id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, tenant, input_json, output_json, error, created_at, updated_at)
     VALUES ($1,$2,'pending',$3,0,$4,$5,NULL,$6,$7,$8,NULL,NULL,$9,$10)`,
    [id, input.kind, input.priority ?? 50, input.maxAttempts ?? 3, input.runAfter ?? now, input.parentJobId ?? null, tenantForJobInput(input.input), JSON.stringify(input.input ?? {}), now, now],
  );
  return (await getMemoryJob(exec, id))!;
}

export async function getMemoryJob(exec: Executor, id: string): Promise<MemoryJobRecord | null> {
  const row = await exec.one(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [id]);
  return row ? jobRowToRecord(row as any) : null;
}

/** Append an activity event atomically; progress is observability, never control flow. */
export async function appendJobProgress(exec: Executor, id: string, event: MemoryJobProgressEvent): Promise<void> {
  await exec.run(
    "UPDATE memory_jobs SET progress_json = ((progress_json::jsonb || $1::jsonb)::text), updated_at = $2 WHERE id = $3",
    [JSON.stringify([event]), new Date().toISOString(), id],
  );
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
          WHERE kind IN ('pr-security-review','pr-code-review','pr-pentest','domain-pentest')
            AND (input_json::jsonb ->> 'orgId') = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`),
    [orgId, limit],
  );
  return rows.map((r) => jobRowToRecord(r as any));
}

/** Latest state per repository/PR/lens for the PR list. Deliberately projects
 * counts/verdict fields only: list pages must not deserialize progress arrays or
 * up to fifty finding-detail objects for every historical job. */
export async function listReviewJobSummariesForOrg(exec: Executor, orgId: string, limit = 2_000): Promise<MemoryJobRecord[]> {
  const rows = await exec.rows(
    pg(`SELECT DISTINCT ON (
            (input_json::jsonb ->> 'repo'),
            (input_json::jsonb ->> 'prNumber'),
            kind
          )
          id, kind, status, 0 AS priority, 0 AS attempts, 0 AS max_attempts,
          created_at AS run_after, NULL::text AS locked_at, parent_job_id, input_json,
          jsonb_build_object(
            'findings', output_json::jsonb -> 'findings',
            'blocking', output_json::jsonb -> 'blocking',
            'posted', output_json::jsonb -> 'posted',
            'error', output_json::jsonb -> 'error',
            'skipped', output_json::jsonb -> 'skipped'
          )::text AS output_json,
          '[]'::text AS progress_json, error, created_at, updated_at
       FROM memory_jobs
      WHERE kind IN (${REVIEW_JOB_KINDS})
        AND (input_json::jsonb ->> 'orgId') = ?
      ORDER BY (input_json::jsonb ->> 'repo'),
               (input_json::jsonb ->> 'prNumber'), kind, created_at DESC, id DESC
      LIMIT ?`),
    [orgId, limit],
  );
  return rows.map((row) => jobRowToRecord(row as any));
}

/** Compact analytics projection: retains severity/status facts but omits finding
 * bodies, progress timelines, prompts, and unrelated output fields. */
export async function listReviewAnalyticsForOrg(exec: Executor, orgId: string, since: string, limit = 1_000): Promise<MemoryJobRecord[]> {
  const rows = await exec.rows(
    pg(`SELECT id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id,
        jsonb_build_object('orgId', input_json::jsonb ->> 'orgId', 'repo', input_json::jsonb ->> 'repo',
          'prNumber', input_json::jsonb ->> 'prNumber', 'forge', input_json::jsonb ->> 'forge')::text AS input_json,
        jsonb_build_object(
          'findings', output_json::jsonb -> 'findings', 'blocking', output_json::jsonb -> 'blocking',
          'findingsDetail', COALESCE((SELECT jsonb_agg(jsonb_build_object('severity', finding ->> 'severity', 'status', finding ->> 'status'))
            FROM jsonb_array_elements(COALESCE(output_json::jsonb -> 'findingsDetail', '[]'::jsonb)) AS finding), '[]'::jsonb)
        )::text AS output_json,
        '[]'::text AS progress_json, error, created_at, updated_at
       FROM memory_jobs
      WHERE kind IN (${REVIEW_ALL_KINDS}) AND (input_json::jsonb ->> 'orgId') = ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?`),
    [orgId, since, limit],
  );
  return rows.map((row) => jobRowToRecord(row as any));
}

/** Full durable activity for exactly one PR. This powers detail and polling
 * without scanning every review job in an organization. */
export async function listReviewJobsForPr(
  exec: Executor,
  orgId: string,
  repo: string,
  prNumber: number,
  limit = 50,
): Promise<MemoryJobRecord[]> {
  const rows = await exec.rows(
    pg(`SELECT ${JOB_COLUMNS} FROM memory_jobs
      WHERE kind IN (${REVIEW_JOB_KINDS})
        AND (input_json::jsonb ->> 'orgId') = ?
        AND (input_json::jsonb ->> 'repo') = ?
        AND (input_json::jsonb ->> 'prNumber') = ?
      ORDER BY created_at DESC, id DESC LIMIT ?`),
    [orgId, repo, String(prNumber), limit],
  );
  return rows.map((row) => jobRowToRecord(row as any));
}

/** Cursor-paginated finding projection for Issues. Filtering stays in Postgres
 * so the browser never downloads unrelated review jobs or progress payloads. */
export async function listReviewFindingsForOrg(
  exec: Executor,
  orgId: string,
  query: ReviewFindingQuery = {},
): Promise<ReviewFindingRow[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
  const where: string[] = [];
  const params: unknown[] = [orgId];
  if (query.severity) { where.push("LOWER(finding ->> 'severity') = ?"); params.push(query.severity.toLowerCase()); }
  if (query.repo) { where.push("repo = ?"); params.push(query.repo); }
  if (query.status) { where.push("LOWER(issue_status) = ?"); params.push(query.status.toLowerCase()); }
  if (query.search) {
    where.push("(COALESCE(finding ->> 'title','') || ' ' || COALESCE(finding ->> 'summary','') || ' ' || COALESCE(finding ->> 'file','') || ' ' || COALESCE(repo,'')) ILIKE ?");
    params.push(`%${query.search}%`);
  }
  if (query.cursor) {
    where.push(`(created_at, review_id, ordinal) ${query.sort === "oldest" ? ">" : "<"} (?, ?, ?)`);
    params.push(query.cursor.createdAt, query.cursor.reviewId, query.cursor.ordinal);
  }
  params.push(limit + 1);

  const rows = await exec.rows<Record<string, unknown>>(
    pg(`WITH expanded AS (
      SELECT j.id AS review_id, j.kind, j.status AS review_status,
             j.input_json::jsonb ->> 'repo' AS repo,
             NULLIF(j.input_json::jsonb ->> 'prNumber','')::integer AS pr_number,
             j.created_at, j.updated_at, f.ordinality::integer AS ordinal,
             f.value AS finding,
             COALESCE(f.value ->> 'status', CASE WHEN j.status IN ('pending','running') THEN 'in progress' ELSE 'open' END) AS issue_status
        FROM memory_jobs j
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.output_json::jsonb -> 'findingsDetail', '[]'::jsonb))
          WITH ORDINALITY AS f(value, ordinality)
       WHERE j.kind IN (${REVIEW_ALL_KINDS})
         AND (j.input_json::jsonb ->> 'orgId') = ?
    ), filtered AS (
      SELECT * FROM expanded ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    )
    SELECT *, COUNT(*) OVER() AS total,
           SUM(CASE WHEN LOWER(finding ->> 'severity') = 'critical' THEN 1 ELSE 0 END) OVER() AS critical_count,
           SUM(CASE WHEN LOWER(finding ->> 'severity') = 'high' THEN 1 ELSE 0 END) OVER() AS high_count,
           SUM(CASE WHEN LOWER(finding ->> 'severity') = 'medium' THEN 1 ELSE 0 END) OVER() AS medium_count,
           SUM(CASE WHEN LOWER(finding ->> 'severity') = 'low' THEN 1 ELSE 0 END) OVER() AS low_count,
           SUM(CASE WHEN LOWER(finding ->> 'severity') = 'info' THEN 1 ELSE 0 END) OVER() AS info_count
      FROM filtered
     ORDER BY created_at ${query.sort === "oldest" ? "ASC" : "DESC"}, review_id ${query.sort === "oldest" ? "ASC" : "DESC"}, ordinal ${query.sort === "oldest" ? "ASC" : "DESC"}
     LIMIT ?`),
    params,
  );
  const parseFinding = (value: unknown): Record<string, unknown> => {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
    return {};
  };
  return rows.map((row) => ({
    reviewId: String(row.review_id),
    lens: row.kind === "pr-code-review" ? "code" : row.kind === "pr-pentest" || row.kind === "domain-pentest" ? "pentest" : "security",
    reviewStatus: String(row.review_status),
    repo: row.repo == null ? null : String(row.repo),
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    issueStatus: String(row.issue_status),
    ordinal: Number(row.ordinal),
    finding: parseFinding(row.finding),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    total: asNumber(row.total),
    severityCounts: {
      critical: asNumber(row.critical_count), high: asNumber(row.high_count), medium: asNumber(row.medium_count),
      low: asNumber(row.low_count), info: asNumber(row.info_count),
    },
  }));
}

export async function listPentestJobsForOrg(exec: Executor, orgId: string, limit = 100): Promise<MemoryJobRecord[]> {
  const rows = await exec.rows(
    pg(`SELECT ${JOB_COLUMNS} FROM memory_jobs
          WHERE kind IN ('domain-pentest','pr-pentest')
            AND (input_json::jsonb ->> 'orgId') = ?
         ORDER BY created_at DESC, id DESC LIMIT ?`),
    [orgId, limit],
  );
  return rows.map((r) => jobRowToRecord(r as any));
}

/**
 * Atomically claim the next eligible pending job (highest priority, oldest first)
 * and flip it to `running`. `FOR UPDATE SKIP LOCKED` makes this safe to run from
 * many workers concurrently — each takes a distinct row.
 *
 * `perTenantLimit` enforces per-tenant fairness at claim time: a pending job is
 * ineligible while its tenant already has `>= perTenantLimit` rows in `running`,
 * so a busy org can't monopolize the workers and starve everyone else. With a
 * single runner process the cap is exact (each claim commits before the next
 * counts); across MULTIPLE worker processes it is a soft cap — the running-count
 * subquery reads under READ COMMITTED and SKIP LOCKED doesn't serialize it, so
 * concurrent claimers for the same tenant can momentarily exceed it by up to
 * (workers − 1). That's an accepted fairness bound, not a hard invariant. A
 * NULL-tenant job is exempt (bounded only by the caller's global ceiling). Omit
 * the option for the original unbounded behavior.
 */
export async function claimNextMemoryJob(exec: Executor, options?: { now?: string; perTenantLimit?: number }): Promise<MemoryJobRecord | null> {
  const now = options?.now ?? new Date().toISOString();
  const capped = typeof options?.perTenantLimit === "number" && options.perTenantLimit > 0;
  return exec.tx(async (client) => {
    const params: unknown[] = [now];
    let tenantClause = "";
    if (capped) {
      params.push(options!.perTenantLimit);
      tenantClause = `AND (memory_jobs.tenant IS NULL OR (
             SELECT count(*) FROM memory_jobs r
              WHERE r.status = 'running' AND r.tenant = memory_jobs.tenant
           ) < $${params.length})`;
    }
    const sel = await client.query<{ id: string }>(
      `SELECT id FROM memory_jobs
        WHERE status = 'pending' AND run_after <= $1
          ${tenantClause}
        ORDER BY priority DESC, run_after ASC, id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      params,
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

/**
 * Supersede-cancel: when a new push arrives for a PR, cancel any still-PENDING
 * review job for the same (org, repo, PR) so repeated commits never pile up
 * superseded reviews — only the newest head is reviewed. An already-RUNNING review
 * is left to finish. Scoped to the org via the materialized `tenant` column.
 * Returns the number of jobs cancelled.
 */
export async function cancelSupersededReviewJobs(
  exec: Executor,
  input: { orgId: string; repo: string; prNumber: number },
  options?: { now?: string },
): Promise<number> {
  const now = options?.now ?? new Date().toISOString();
  return exec.run(
    `UPDATE memory_jobs
        SET status = 'cancelled', error = COALESCE(error, 'superseded by a newer push'), locked_at = NULL, updated_at = $1
      WHERE status = 'pending'
        AND kind IN ('pr-security-review','pr-code-review')
        AND tenant = $2
        AND (input_json::jsonb ->> 'repo') = $3
        AND (input_json::jsonb ->> 'prNumber') = $4`,
    [now, input.orgId, input.repo, String(input.prNumber)],
  );
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
