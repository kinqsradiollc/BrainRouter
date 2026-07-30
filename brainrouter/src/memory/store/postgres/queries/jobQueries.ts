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
import { reconcileFindingLifecycle, type LifecycleCurrentFinding, type LifecycleFindingInput } from "../../../../reviews/findingLifecycle.js";
import type { PoolClient } from "pg";

const JOB_COLUMNS =
  "id, kind, status, priority, attempts, max_attempts, run_after, locked_at, parent_job_id, input_json, output_json, progress_json, error, created_at, updated_at";

const REVIEW_JOB_KINDS = "'pr-security-review','pr-code-review','pr-pentest'";
const REVIEW_ALL_KINDS = `${REVIEW_JOB_KINDS},'domain-pentest'`;

const REVIEW_LENS_BY_KIND: Record<string, "security" | "code" | "pentest"> = {
  "pr-security-review": "security",
  "pr-code-review": "code",
  "pr-pentest": "pentest",
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function cleanText(value: unknown, max = 2_000): string | undefined {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function findingInput(value: unknown): LifecycleFindingInput | null {
  const row = objectValue(value);
  const file = cleanText(row.file, 2_000);
  const title = cleanText(row.title ?? row.summary, 4_000);
  if (!file || !title) return null;
  const line = positiveInteger(row.line);
  const endLine = positiveInteger(row.endLine);
  return {
    file,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    severity: cleanText(row.severity, 50)?.toLowerCase() ?? "info",
    title,
    ...(cleanText(row.cwe, 50) ? { cwe: cleanText(row.cwe, 50) } : {}),
    ...(row.preExisting === true ? { preExisting: true } : {}),
    ...(row.suggestable === true ? { suggestable: true } : {}),
  };
}

export interface CompletedReviewProjection {
  id: string;
  kind: string;
  input: Record<string, unknown>;
  output: unknown;
  createdAt: string;
  occurredAt: string;
}

/**
 * Project one successful PR-review job into the durable lifecycle tables.
 * The caller owns the transaction. A per-org/PR/lens advisory lock serializes
 * synchronize events, and review_job_projections makes clean jobs idempotent.
 */
export async function reconcileCompletedReviewProjection(client: PoolClient, job: CompletedReviewProjection): Promise<void> {
  const lens = REVIEW_LENS_BY_KIND[job.kind];
  const input = objectValue(job.input);
  const output = objectValue(job.output);
  const orgId = cleanText(input.orgId, 255);
  const forge = input.forge === "gitlab" ? "gitlab" : "github";
  const repository = cleanText(input.repo, 2_000);
  const prNumber = positiveInteger(input.prNumber);
  if (!lens || !orgId || !repository || !prNumber || output.ok !== true || output.skipped || output.error) return;

  const scope = JSON.stringify([orgId, forge, repository.toLowerCase(), prNumber, lens]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  const projected = await client.query(
    `INSERT INTO review_job_projections
      (review_id, org_id, forge, repository, pr_number, lens, review_created_at, projected_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (review_id) DO NOTHING
     RETURNING review_id`,
    [job.id, orgId, forge, repository, prNumber, lens, job.createdAt, job.occurredAt],
  );
  if ((projected.rowCount ?? 0) === 0) return;
  const newerProjection = (await client.query(
    `SELECT review_id, review_created_at
       FROM review_job_projections
      WHERE org_id = $1 AND forge = $2 AND repository = $3 AND pr_number = $4 AND lens = $5 AND review_id <> $6
      ORDER BY review_created_at DESC, review_id DESC
      LIMIT 1`,
    [orgId, forge, repository, prNumber, lens, job.id],
  )).rows[0];
  if (newerProjection && (
    String(newerProjection.review_created_at) > job.createdAt
    || (String(newerProjection.review_created_at) === job.createdAt && String(newerProjection.review_id) > job.id)
  )) return;

  const headSha = cleanText(output.headSha ?? input.headSha, 255);
  const prAuthor = cleanText(output.prAuthor ?? input.prAuthor, 255);
  const triggeredByLogin = cleanText(output.triggeredByLogin ?? input.triggeredByLogin, 255);
  const headContributor = cleanText(output.headContributor, 255);

  const contributorValues = new Map<string, {
    login: string; displayName?: string; avatarUrl?: string; commitCount: number; isAuthor: boolean;
  }>();
  const rawContributors = Array.isArray(output.contributors) ? output.contributors.slice(0, 100) : [];
  for (const raw of rawContributors) {
    const row = objectValue(raw);
    const login = cleanText(row.login, 255);
    if (!login) continue;
    const key = login.toLowerCase();
    const existing = contributorValues.get(key);
    contributorValues.set(key, {
      login: existing?.login ?? login,
      displayName: cleanText(row.displayName, 255) ?? existing?.displayName,
      avatarUrl: cleanText(row.avatarUrl, 2_000) ?? existing?.avatarUrl,
      commitCount: Math.max(existing?.commitCount ?? 0, Math.max(0, Math.floor(Number(row.commitCount) || 0))),
      isAuthor: existing?.isAuthor === true || row.isAuthor === true || key === prAuthor?.toLowerCase(),
    });
  }
  if (prAuthor && !contributorValues.has(prAuthor.toLowerCase())) {
    contributorValues.set(prAuthor.toLowerCase(), { login: prAuthor, commitCount: 0, isAuthor: true });
  }
  for (const contributor of contributorValues.values()) {
    await client.query(
      `INSERT INTO review_pr_contributors
        (org_id, forge, repository, pr_number, login, display_name, avatar_url, is_author, commit_count,
         latest_head_sha, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (org_id, forge, repository, pr_number, login) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, review_pr_contributors.display_name),
         avatar_url = COALESCE(EXCLUDED.avatar_url, review_pr_contributors.avatar_url),
         is_author = review_pr_contributors.is_author OR EXCLUDED.is_author,
         commit_count = GREATEST(review_pr_contributors.commit_count, EXCLUDED.commit_count),
         latest_head_sha = COALESCE(EXCLUDED.latest_head_sha, review_pr_contributors.latest_head_sha),
         last_seen_at = GREATEST(review_pr_contributors.last_seen_at, EXCLUDED.last_seen_at)`,
      [orgId, forge, repository, prNumber, contributor.login, contributor.displayName ?? null, contributor.avatarUrl ?? null,
        contributor.isAuthor, contributor.commitCount, headSha ?? null, job.occurredAt, job.occurredAt],
    );
  }

  const currentRows = await client.query(
    `SELECT id, fingerprint, file_path, title, cwe, status
       FROM review_findings
      WHERE org_id = $1 AND forge = $2 AND repository = $3 AND pr_number = $4 AND lens = $5
      FOR UPDATE`,
    [orgId, forge, repository, prNumber, lens],
  );
  const previous: LifecycleCurrentFinding[] = currentRows.rows.map((row) => ({
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    file: String(row.file_path),
    title: String(row.title),
    ...(row.cwe ? { cwe: String(row.cwe) } : {}),
    status: String(row.status) as LifecycleCurrentFinding["status"],
  }));
  const incoming = (Array.isArray(output.findingsDetail) ? output.findingsDetail : [])
    .map(findingInput)
    .filter((finding): finding is LifecycleFindingInput => finding !== null);
  const coverage = objectValue(output.coverage);
  const complete = coverage.complete === true;
  const { transitions } = reconcileFindingLifecycle({ lens, previous, incoming, complete });

  for (const transition of transitions) {
    let findingId = transition.findingId;
    const finding = transition.finding;
    if (transition.type === "discovered" && finding) {
      findingId = randomUUID();
      await client.query(
        `INSERT INTO review_findings
          (id, org_id, forge, repository, pr_number, lens, fingerprint, status, severity, title, file_path,
           line_start, line_end, cwe, pre_existing, suggestable, first_seen_review_id, last_seen_review_id,
           first_seen_sha, last_seen_sha, first_seen_at, last_seen_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [findingId, orgId, forge, repository, prNumber, lens, transition.fingerprint, finding.severity, finding.title,
          finding.file, finding.line ?? null, finding.endLine ?? null, finding.cwe ?? null, finding.preExisting === true,
          finding.suggestable === true, job.id, job.id, headSha ?? null, headSha ?? null, job.occurredAt, job.occurredAt, job.occurredAt],
      );
    } else if ((transition.type === "observed" || transition.type === "reopened") && findingId && finding) {
      const reopened = transition.type === "reopened";
      await client.query(
        `UPDATE review_findings SET
           fingerprint = $1, severity = $2, title = $3, file_path = $4, line_start = $5, line_end = $6,
           cwe = $7, pre_existing = $8, suggestable = $9, last_seen_review_id = $10, last_seen_sha = $11,
           last_seen_at = $12, updated_at = $12,
           status = CASE WHEN $13 THEN 'open' ELSE status END,
           fixed_review_id = CASE WHEN $13 THEN NULL ELSE fixed_review_id END,
           fixed_sha = CASE WHEN $13 THEN NULL ELSE fixed_sha END,
           fixed_at = CASE WHEN $13 THEN NULL ELSE fixed_at END,
           resolved_by_login = CASE WHEN $13 THEN NULL ELSE resolved_by_login END
         WHERE id = $14`,
        [transition.fingerprint, finding.severity, finding.title, finding.file, finding.line ?? null, finding.endLine ?? null,
          finding.cwe ?? null, finding.preExisting === true, finding.suggestable === true, job.id, headSha ?? null,
          job.occurredAt, reopened, findingId],
      );
    } else if (transition.type === "fixed" && findingId) {
      await client.query(
        `UPDATE review_findings SET status = 'fixed', fixed_review_id = $1, fixed_sha = $2, fixed_at = $3,
           resolved_by_login = $4, updated_at = $3
         WHERE id = $5`,
        [job.id, headSha ?? null, job.occurredAt, headContributor ?? null, findingId],
      );
    }
    if (!findingId) continue;
    const actor = transition.type === "fixed" ? headContributor : (headContributor ?? triggeredByLogin);
    await client.query(
      `INSERT INTO review_finding_events
        (id, finding_id, org_id, forge, repository, pr_number, lens, event_type, review_id, head_sha, actor_login, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (finding_id, review_id, event_type) DO NOTHING`,
      [randomUUID(), findingId, orgId, forge, repository, prNumber, lens, transition.type, job.id,
        headSha ?? null, actor ?? null, job.occurredAt],
    );
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return objectValue(value);
  try { return objectValue(JSON.parse(value)); } catch { return {}; }
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** Infer the old executor's completeness only from persisted positive terminal
 * evidence and the absence of its known partial-review signals. */
function withHistoricalCoverage(rawOutput: unknown, rawProgress: unknown): Record<string, unknown> {
  const output = parseJsonObject(rawOutput);
  const explicit = objectValue(output.coverage);
  if (typeof explicit.complete === "boolean") return output;
  const progress = parseJsonArray(rawProgress).map(objectValue);
  let totalParts = 0;
  let reviewedParts = 0;
  let failedParts = 0;
  let unreviewedParts = 0;
  let terminalDone = false;
  for (const event of progress) {
    const kind = cleanText(event.kind, 100) ?? "";
    const data = objectValue(event.data);
    if (kind === "diff-fetched") {
      totalParts = Math.max(totalParts, Math.max(0, Math.floor(Number(data.parts) || 0)));
      unreviewedParts = Math.max(unreviewedParts, Math.max(0, Math.floor(Number(data.unreviewedParts) || 0)));
    }
    if (kind === "llm-finished" && data.failed === true) failedParts += 1;
    if (kind === "done") terminalDone = true;
    if (kind === "error" || event.status === "failed") failedParts += 1;
  }
  reviewedParts = Math.max(0, totalParts - failedParts);
  const detailCount = Array.isArray(output.findingsDetail) ? output.findingsDetail.length : 0;
  const unrecordedFindings = Math.max(0, Math.floor(Number(output.findings) || 0) - detailCount);
  return {
    ...output,
    coverage: {
      complete: output.ok === true && !output.skipped && !output.error && terminalDone
        && failedParts === 0 && unreviewedParts === 0 && unrecordedFindings === 0,
      totalParts,
      reviewedParts,
      failedParts,
      unreviewedParts,
      unrecordedFindings,
      inferred: true,
    },
  };
}

/** Replay successful legacy jobs in chronological batches. The projection
 * ledger, not an in-memory flag, is the resume boundary; this also repairs a
 * job completed by an older replica during a rolling upgrade. */
export async function backfillReviewLifecycle(exec: Executor, options: { batchSize?: number; now?: string } = {}): Promise<number> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1_000);
  const now = options.now ?? new Date().toISOString();
  let projected = 0;
  for (;;) {
    const batchCount = await exec.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('brainrouter:review-lifecycle-backfill:v1', 0))");
      await client.query(
        `INSERT INTO review_lifecycle_backfill (scope, last_created_at, last_job_id, completed_at, updated_at)
         VALUES ('memory_jobs_v1', NULL, NULL, NULL, $1)
         ON CONFLICT (scope) DO NOTHING`,
        [now],
      );
      const rows = (await client.query(
        `SELECT j.id, j.kind, j.input_json, j.output_json, j.progress_json, j.created_at, j.updated_at
           FROM memory_jobs j
           LEFT JOIN review_job_projections p ON p.review_id = j.id
          WHERE j.kind IN (${REVIEW_JOB_KINDS})
            AND j.status = 'done'
            AND p.review_id IS NULL
            AND j.output_json IS NOT NULL
            AND j.output_json::jsonb ->> 'ok' = 'true'
            AND COALESCE(j.output_json::jsonb ->> 'skipped', '') = ''
            AND COALESCE(j.output_json::jsonb ->> 'error', '') = ''
            AND COALESCE(j.input_json::jsonb ->> 'orgId', '') <> ''
            AND COALESCE(j.input_json::jsonb ->> 'repo', '') <> ''
            AND COALESCE(j.input_json::jsonb ->> 'prNumber', '') ~ '^[1-9][0-9]*$'
          ORDER BY j.created_at ASC, j.id ASC
          LIMIT $1`,
        [batchSize],
      )).rows;
      for (const row of rows) {
        await reconcileCompletedReviewProjection(client, {
          id: String(row.id),
          kind: String(row.kind),
          input: parseJsonObject(row.input_json),
          output: withHistoricalCoverage(row.output_json, row.progress_json),
          createdAt: String(row.created_at),
          occurredAt: String(row.updated_at),
        });
      }
      const last = rows.at(-1);
      await client.query(
        `UPDATE review_lifecycle_backfill SET
           last_created_at = COALESCE($1, last_created_at),
           last_job_id = COALESCE($2, last_job_id),
           completed_at = CASE WHEN $3 THEN $4 ELSE NULL END,
           updated_at = $4
         WHERE scope = 'memory_jobs_v1'`,
        [last ? String(last.created_at) : null, last ? String(last.id) : null, rows.length === 0, now],
      );
      return rows.length;
    });
    projected += batchCount;
    if (batchCount === 0) return projected;
  }
}

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
  // Heartbeat the lock while the job is running: emitting progress proves the
  // worker is alive, so renew `locked_at` to keep the sweeper from reclaiming a
  // long but healthy job (e.g. a multi-minute pentest). A dead process emits no
  // progress, so its lock still ages out and gets swept as intended. Terminal
  // rows keep their `locked_at` (the CASE guard) so we never resurrect a lease.
  const now = new Date().toISOString();
  await exec.run(
    "UPDATE memory_jobs SET progress_json = ((progress_json::jsonb || $1::jsonb)::text), updated_at = $2, locked_at = CASE WHEN status = 'running' THEN $2 ELSE locked_at END WHERE id = $3",
    [JSON.stringify([event]), now, id],
  );
}

/** Renew only a live worker lease without growing the user-visible progress log. */
export async function heartbeatMemoryJob(
  exec: Executor,
  id: string,
  now = new Date().toISOString(),
): Promise<boolean> {
  return (await exec.run(
    "UPDATE memory_jobs SET locked_at = $1, updated_at = $1 WHERE id = $2 AND status = 'running'",
    [now, id],
  )) > 0;
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

export interface ReviewLifecycleSummary {
  metrics: { issuesFound: number; issuesFixed: number; openIssues: number; meanTimeToRemediateDays: number | null };
  severity: { critical: number; high: number; medium: number; low: number; info: number };
  history: Array<{ date: string; critical: number; high: number; medium: number; low: number; open: number; fixed: number }>;
  repositories: Array<{ repository: string; findings: number; addressed: number }>;
  contributors: Array<{
    login: string; displayName: string | null; avatarUrl: string | null;
    prs: number; authoredPrs: number; commits: number; findingsFixed: number; openFindings: number; lastActivityAt: string | null;
  }>;
}

/** Durable lifecycle analytics. Job executions remain the activity source;
 * findings, fixes, remediation time, and contributors come only from the
 * normalized projections so repeated commits never double-count one issue. */
export async function getReviewLifecycleSummaryForOrg(exec: Executor, orgId: string, since: string): Promise<ReviewLifecycleSummary> {
  const metricRows = await exec.rows<Record<string, unknown>>(
    `SELECT
       COUNT(*) FILTER (WHERE first_seen_at >= $2)::integer AS issues_found,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status = 'fixed')::integer AS issues_fixed,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored'))::integer AS open_issues,
       AVG((EXTRACT(EPOCH FROM fixed_at::timestamptz) - EXTRACT(EPOCH FROM first_seen_at::timestamptz)) / 86400.0)
         FILTER (WHERE first_seen_at >= $2 AND status = 'fixed' AND fixed_at IS NOT NULL) AS mttr_days,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored') AND LOWER(severity) = 'critical')::integer AS critical,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored') AND LOWER(severity) = 'high')::integer AS high,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored') AND LOWER(severity) = 'medium')::integer AS medium,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored') AND LOWER(severity) = 'low')::integer AS low,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status NOT IN ('fixed','ignored') AND LOWER(severity) = 'info')::integer AS info
     FROM review_findings WHERE org_id = $1`,
    [orgId, since],
  );
  const historyRows = await exec.rows<Record<string, unknown>>(
    `WITH discoveries AS (
       SELECT LEFT(first_seen_at, 10) AS day,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'critical')::integer AS critical,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'high')::integer AS high,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'medium')::integer AS medium,
         COUNT(*) FILTER (WHERE LOWER(severity) = 'low')::integer AS low,
         COUNT(*) FILTER (WHERE status NOT IN ('fixed','ignored'))::integer AS open,
         0::integer AS fixed
       FROM review_findings WHERE org_id = $1 AND first_seen_at >= $2 GROUP BY LEFT(first_seen_at, 10)
     ), fixes AS (
       SELECT LEFT(occurred_at, 10) AS day, 0::integer AS critical, 0::integer AS high, 0::integer AS medium,
         0::integer AS low, 0::integer AS open, COUNT(*)::integer AS fixed
       FROM review_finding_events WHERE org_id = $1 AND event_type = 'fixed' AND occurred_at >= $2 GROUP BY LEFT(occurred_at, 10)
     )
     SELECT day, SUM(critical)::integer AS critical, SUM(high)::integer AS high,
       SUM(medium)::integer AS medium, SUM(low)::integer AS low,
       SUM(open)::integer AS open, SUM(fixed)::integer AS fixed
     FROM (SELECT * FROM discoveries UNION ALL SELECT * FROM fixes) activity
     GROUP BY day ORDER BY day`,
    [orgId, since],
  );
  const repositoryRows = await exec.rows<Record<string, unknown>>(
    `SELECT repository,
       COUNT(*) FILTER (WHERE first_seen_at >= $2)::integer AS findings,
       COUNT(*) FILTER (WHERE first_seen_at >= $2 AND status = 'fixed')::integer AS addressed
     FROM review_findings WHERE org_id = $1
     GROUP BY repository
     HAVING COUNT(*) FILTER (WHERE first_seen_at >= $2) > 0
     ORDER BY findings DESC, repository ASC`,
    [orgId, since],
  );
  const contributorRows = await exec.rows<Record<string, unknown>>(
    `WITH contribution AS (
       SELECT LOWER(login) AS identity, MIN(login) AS login,
         MAX(display_name) AS display_name, MAX(avatar_url) AS avatar_url,
         COUNT(*) FILTER (WHERE last_seen_at >= $2)::integer AS prs,
         COUNT(*) FILTER (WHERE last_seen_at >= $2 AND is_author)::integer AS authored_prs,
         COALESCE(SUM(commit_count) FILTER (WHERE last_seen_at >= $2), 0)::integer AS commits,
         MAX(last_seen_at) FILTER (WHERE last_seen_at >= $2) AS last_activity_at
       FROM review_pr_contributors WHERE org_id = $1 GROUP BY LOWER(login)
     ), fixes AS (
       SELECT LOWER(actor_login) AS identity, COUNT(*)::integer AS findings_fixed
       FROM review_finding_events
       WHERE org_id = $1 AND event_type = 'fixed' AND occurred_at >= $2 AND actor_login IS NOT NULL
       GROUP BY LOWER(actor_login)
     ), author_open AS (
       SELECT LOWER(contributor.login) AS identity, COUNT(finding.id)::integer AS open_findings
       FROM review_pr_contributors contributor
       JOIN review_findings finding
         ON finding.org_id = contributor.org_id AND finding.forge = contributor.forge
        AND finding.repository = contributor.repository AND finding.pr_number = contributor.pr_number
       WHERE contributor.org_id = $1 AND contributor.is_author
         AND finding.first_seen_at >= $2 AND finding.status NOT IN ('fixed','ignored')
       GROUP BY LOWER(contributor.login)
     )
     SELECT COALESCE(contribution.login, fixes.identity) AS login,
       contribution.display_name, contribution.avatar_url,
       COALESCE(contribution.prs, 0)::integer AS prs,
       COALESCE(contribution.authored_prs, 0)::integer AS authored_prs,
       COALESCE(contribution.commits, 0)::integer AS commits,
       COALESCE(fixes.findings_fixed, 0)::integer AS findings_fixed,
       COALESCE(author_open.open_findings, 0)::integer AS open_findings,
       contribution.last_activity_at
     FROM contribution FULL OUTER JOIN fixes USING (identity)
     LEFT JOIN author_open USING (identity)
     WHERE COALESCE(contribution.prs, 0) > 0 OR COALESCE(fixes.findings_fixed, 0) > 0
     ORDER BY findings_fixed DESC, prs DESC, commits DESC, login ASC
     LIMIT 50`,
    [orgId, since],
  );
  const metric = metricRows[0] ?? {};
  const count = (value: unknown) => asNumber(value, 0);
  const mttr = metric.mttr_days == null ? null : Number(metric.mttr_days);
  return {
    metrics: {
      issuesFound: count(metric.issues_found), issuesFixed: count(metric.issues_fixed),
      openIssues: count(metric.open_issues), meanTimeToRemediateDays: Number.isFinite(mttr) ? mttr : null,
    },
    severity: {
      critical: count(metric.critical), high: count(metric.high), medium: count(metric.medium),
      low: count(metric.low), info: count(metric.info),
    },
    history: historyRows.map((row) => ({
      date: String(row.day), critical: count(row.critical), high: count(row.high), medium: count(row.medium),
      low: count(row.low), open: count(row.open), fixed: count(row.fixed),
    })),
    repositories: repositoryRows.map((row) => ({
      repository: String(row.repository), findings: count(row.findings), addressed: count(row.addressed),
    })),
    contributors: contributorRows.map((row) => ({
      login: String(row.login), displayName: row.display_name == null ? null : String(row.display_name),
      avatarUrl: row.avatar_url == null ? null : String(row.avatar_url), prs: count(row.prs),
      authoredPrs: count(row.authored_prs), commits: count(row.commits), findingsFixed: count(row.findings_fixed),
      openFindings: count(row.open_findings), lastActivityAt: row.last_activity_at == null ? null : String(row.last_activity_at),
    })),
  };
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
  if (query.severity) { where.push("LOWER(severity) = ?"); params.push(query.severity.toLowerCase()); }
  if (query.repo) { where.push("repo = ?"); params.push(query.repo); }
  if (query.status) { where.push("LOWER(issue_status) = ?"); params.push(query.status.toLowerCase()); }
  if (query.search) {
    where.push("(COALESCE(title,'') || ' ' || COALESCE(file_path,'') || ' ' || COALESCE(repo,'')) ILIKE ?");
    params.push(`%${query.search}%`);
  }
  if (query.cursor) {
    where.push(`(created_at, review_id, ordinal) ${query.sort === "oldest" ? ">" : "<"} (?, ?, ?)`);
    params.push(query.cursor.createdAt, query.cursor.reviewId, query.cursor.ordinal);
  }
  params.push(limit + 1);

  const rows = await exec.rows<Record<string, unknown>>(
    pg(`WITH durable AS (
      SELECT first_seen_review_id AS review_id, lens, 'done'::text AS review_status,
             repository AS repo, pr_number, first_seen_at AS created_at, updated_at,
             ROW_NUMBER() OVER (PARTITION BY first_seen_review_id ORDER BY id)::integer AS ordinal,
             severity, title, file_path, status AS issue_status,
             jsonb_strip_nulls(jsonb_build_object(
               'file', file_path, 'line', line_start, 'endLine', line_end,
               'severity', severity, 'title', title, 'cwe', cwe,
               'preExisting', CASE WHEN pre_existing THEN true ELSE NULL END,
               'suggestable', CASE WHEN suggestable THEN true ELSE NULL END,
               'status', status,
               'firstSeenAt', first_seen_at, 'lastSeenAt', last_seen_at, 'fixedAt', fixed_at,
               'firstSeenSha', first_seen_sha, 'lastSeenSha', last_seen_sha, 'fixedSha', fixed_sha,
               'resolvedByLogin', resolved_by_login
             )) AS finding
        FROM review_findings
       WHERE org_id = ?
    ), legacy_pentest AS (
      SELECT j.id AS review_id, 'pentest'::text AS lens, j.status AS review_status,
             COALESCE(j.input_json::jsonb ->> 'repo', j.input_json::jsonb ->> 'target') AS repo,
             NULLIF(j.input_json::jsonb ->> 'prNumber','')::integer AS pr_number,
             j.created_at, j.updated_at, f.ordinality::integer AS ordinal,
             COALESCE(f.value ->> 'severity', 'info') AS severity,
             COALESCE(f.value ->> 'title', f.value ->> 'summary', 'Pentest finding') AS title,
             COALESCE(f.value ->> 'file', '') AS file_path,
             COALESCE(f.value ->> 'status', 'open') AS issue_status,
             f.value AS finding
        FROM memory_jobs j
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.output_json::jsonb -> 'findingsDetail', '[]'::jsonb))
          WITH ORDINALITY AS f(value, ordinality)
       WHERE j.kind = 'domain-pentest'
         AND (j.input_json::jsonb ->> 'orgId') = ?
    ), scoped AS (
      SELECT * FROM durable UNION ALL SELECT * FROM legacy_pentest
    ), filtered AS (
      SELECT * FROM scoped ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    )
    SELECT *, COUNT(*) OVER() AS total,
           SUM(CASE WHEN LOWER(severity) = 'critical' THEN 1 ELSE 0 END) OVER() AS critical_count,
           SUM(CASE WHEN LOWER(severity) = 'high' THEN 1 ELSE 0 END) OVER() AS high_count,
           SUM(CASE WHEN LOWER(severity) = 'medium' THEN 1 ELSE 0 END) OVER() AS medium_count,
           SUM(CASE WHEN LOWER(severity) = 'low' THEN 1 ELSE 0 END) OVER() AS low_count,
           SUM(CASE WHEN LOWER(severity) = 'info' THEN 1 ELSE 0 END) OVER() AS info_count
      FROM filtered
     ORDER BY created_at ${query.sort === "oldest" ? "ASC" : "DESC"}, review_id ${query.sort === "oldest" ? "ASC" : "DESC"}, ordinal ${query.sort === "oldest" ? "ASC" : "DESC"}
     LIMIT ?`),
    [orgId, ...params],
  );
  const parseFinding = (value: unknown): Record<string, unknown> => {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string") { try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; } }
    return {};
  };
  return rows.map((row) => ({
    reviewId: String(row.review_id),
    lens: row.lens === "code" ? "code" : row.lens === "pentest" ? "pentest" : "security",
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
  return exec.tx(async (client) => {
    const current = (await client.query(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!current || current.status !== "running") return null;
    await client.query(
      "UPDATE memory_jobs SET status = 'done', output_json = $1, error = NULL, locked_at = NULL, updated_at = $2 WHERE id = $3",
      [JSON.stringify(output ?? null), now, id],
    );
    let input: Record<string, unknown> = {};
    try { input = objectValue(JSON.parse(String(current.input_json ?? "{}"))); } catch { /* malformed legacy input is not projectable */ }
    await reconcileCompletedReviewProjection(client, {
      id,
      kind: String(current.kind),
      input,
      output,
      createdAt: String(current.created_at),
      occurredAt: now,
    });
    const updated = (await client.query(`SELECT ${JOB_COLUMNS} FROM memory_jobs WHERE id = $1`, [id])).rows[0];
    return updated ? jobRowToRecord(updated as any) : null;
  });
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
