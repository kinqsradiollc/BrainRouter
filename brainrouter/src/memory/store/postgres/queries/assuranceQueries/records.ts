/**
 * Repository-assurance row mapping and tenant-scoped reads.
 *
 * JSON and timestamp decoding lives here so every mutation returns the same
 * host-neutral contract as a later standalone read.
 */

import type {
  AssuranceCoverage,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import type { Executor } from "../executor.js";
import {
  RUN_SELECT,
  type AssuranceRunRow,
  type CoverageRow,
  type Queryable,
  type ReplaceableAssuranceRunsInput,
  type SourceSnapshotRow,
  type StageRow,
} from "./contracts.js";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value: Date | string | null): string | undefined {
  return value === null ? undefined : iso(value);
}

function numberValue(value: number | string): number {
  return Number(value);
}

function optionalNumber(value: number | string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function optionalText(value: string | null): string | undefined {
  return value ?? undefined;
}

export function sourceFromRow(row: SourceSnapshotRow): SourceSnapshot {
  const completedAt = optionalIso(row.completed_at);
  const byteCount = optionalNumber(row.byte_count);
  return {
    id: row.id,
    revision: {
      headSha: row.head_sha,
      ...(row.base_sha ? { baseSha: row.base_sha } : {}),
      ...(row.merge_base_sha ? { mergeBaseSha: row.merge_base_sha } : {}),
    },
    status: row.status,
    ...(row.checkout_ref ? { checkoutRef: row.checkout_ref } : {}),
    ...(row.inventory_ref ? { inventoryRef: row.inventory_ref } : {}),
    fileCount: numberValue(row.file_count),
    textFileCount: numberValue(row.text_file_count),
    indexedFileCount: numberValue(row.indexed_file_count),
    unsupportedFileCount: numberValue(row.unsupported_file_count),
    ...(byteCount !== undefined ? { byteCount } : {}),
    createdAt: iso(row.created_at),
    ...(completedAt ? { completedAt } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

export function coverageFromRow(row: CoverageRow): AssuranceCoverage {
  return {
    status: row.status,
    filesTotal: numberValue(row.files_total),
    filesEligible: numberValue(row.files_eligible),
    filesAnalyzed: numberValue(row.files_analyzed),
    changedFilesTotal: numberValue(row.changed_files_total),
    changedFilesAnalyzed: numberValue(row.changed_files_analyzed),
    analyzers: jsonValue(row.analyzers_json),
    limitations: jsonValue(row.limitations_json),
    calculatedAt: iso(row.calculated_at),
  };
}

export function stageFromRow(row: StageRow): AssuranceStageReceipt {
  const startedAt = optionalIso(row.started_at);
  const completedAt = optionalIso(row.completed_at);
  const durationMs = optionalNumber(row.duration_ms);
  return {
    id: row.id,
    stage: row.stage,
    status: row.status,
    attempt: numberValue(row.attempt),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    inputRefs: jsonValue(row.input_refs_json),
    outputRefs: jsonValue(row.output_refs_json),
    limitationIds: jsonValue(row.limitation_ids_json),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
  };
}

function runFromRows(
  runRow: AssuranceRunRow,
  source: SourceSnapshotRow,
  coverage: CoverageRow,
  stages: StageRow[],
): RepositoryAssuranceRun {
  const completedAt = optionalIso(runRow.completed_at);
  return {
    id: runRow.id,
    repository: {
      forge: runRow.forge,
      slug: runRow.repository,
      ...(optionalText(runRow.repository_id) ? { repositoryId: runRow.repository_id! } : {}),
      ...(optionalText(runRow.default_branch) ? { defaultBranch: runRow.default_branch! } : {}),
    },
    revision: {
      headSha: runRow.head_sha,
      ...(runRow.base_sha ? { baseSha: runRow.base_sha } : {}),
      ...(runRow.merge_base_sha ? { mergeBaseSha: runRow.merge_base_sha } : {}),
    },
    program: runRow.program,
    policySnapshot: jsonValue(runRow.policy_json),
    sourceSnapshot: sourceFromRow(source),
    coverage: coverageFromRow(coverage),
    stages: stages.map(stageFromRow),
    findings: [],
    status: runRow.status,
    createdAt: iso(runRow.created_at),
    updatedAt: iso(runRow.updated_at),
    ...(completedAt ? { completedAt } : {}),
    ...(runRow.superseded_by_run_id ? { supersededByRunId: runRow.superseded_by_run_id } : {}),
    ...(runRow.stale_reason ? { staleReason: runRow.stale_reason } : {}),
  };
}

/** Load one run on an existing transaction client; queries remain sequential. */
export async function loadRun(
  queryable: Queryable,
  orgId: string,
  runId: string,
): Promise<RepositoryAssuranceRun | null> {
  const runRow = (await queryable.query<AssuranceRunRow>(
    `${RUN_SELECT} WHERE org_id = $1 AND id = $2`,
    [orgId, runId],
  )).rows[0];
  if (!runRow) return null;
  const source = (await queryable.query<SourceSnapshotRow>(
    `SELECT id, status, base_sha, head_sha, merge_base_sha, checkout_ref,
            inventory_ref, file_count, text_file_count, indexed_file_count,
            unsupported_file_count, byte_count, error_code, created_at, completed_at
       FROM repository_source_snapshots WHERE run_id = $1`,
    [runId],
  )).rows[0];
  const coverage = (await queryable.query<CoverageRow>(
    `SELECT status, files_total, files_eligible, files_analyzed,
            changed_files_total, changed_files_analyzed, analyzers_json,
            limitations_json, calculated_at
       FROM repository_assurance_coverage WHERE run_id = $1`,
    [runId],
  )).rows[0];
  const stages = (await queryable.query<StageRow>(
    `SELECT id, stage, status, attempt, started_at, completed_at, duration_ms,
            input_refs_json, output_refs_json, limitation_ids_json, error_code
       FROM repository_assurance_stages
      WHERE run_id = $1 ORDER BY stage, attempt, id`,
    [runId],
  )).rows;
  if (!source || !coverage) {
    throw new Error(`Repository assurance run ${runId} is missing its source or coverage receipt.`);
  }
  return runFromRows(runRow, source, coverage, stages);
}

export async function getRepositoryAssuranceRun(
  exec: Executor,
  orgId: string,
  runId: string,
): Promise<RepositoryAssuranceRun | null> {
  const runRow = await exec.one<AssuranceRunRow>(
    `${RUN_SELECT} WHERE org_id = $1 AND id = $2`,
    [orgId, runId],
  );
  if (!runRow) return null;
  const [source, coverage, stages] = await Promise.all([
    exec.one<SourceSnapshotRow>(
      `SELECT id, status, base_sha, head_sha, merge_base_sha, checkout_ref,
              inventory_ref, file_count, text_file_count, indexed_file_count,
              unsupported_file_count, byte_count, error_code, created_at, completed_at
         FROM repository_source_snapshots WHERE run_id = $1`,
      [runId],
    ),
    exec.one<CoverageRow>(
      `SELECT status, files_total, files_eligible, files_analyzed,
              changed_files_total, changed_files_analyzed, analyzers_json,
              limitations_json, calculated_at
         FROM repository_assurance_coverage WHERE run_id = $1`,
      [runId],
    ),
    exec.rows<StageRow>(
      `SELECT id, stage, status, attempt, started_at, completed_at, duration_ms,
              input_refs_json, output_refs_json, limitation_ids_json, error_code
         FROM repository_assurance_stages
        WHERE run_id = $1 ORDER BY stage, attempt, id`,
      [runId],
    ),
  ]);
  if (!source || !coverage) {
    throw new Error(`Repository assurance run ${runId} is missing its source or coverage receipt.`);
  }
  return runFromRows(runRow, source, coverage, stages);
}

/**
 * Active older-head runs for the same PR and program.
 *
 * Job creation time establishes push order; run completion time must never
 * decide which head supersedes another.
 */
export async function listReplaceableRepositoryAssuranceRunIds(
  exec: Executor,
  input: ReplaceableAssuranceRunsInput,
): Promise<string[]> {
  const rows = await exec.rows<{ id: string }>(
    `SELECT prior.id
       FROM repository_assurance_runs prior
       JOIN memory_jobs prior_job ON prior_job.id = prior.job_id
       JOIN repository_assurance_runs replacement
         ON replacement.org_id = $1 AND replacement.id = $2
       JOIN memory_jobs replacement_job ON replacement_job.id = replacement.job_id
      WHERE prior.org_id = $1
        AND prior.id <> replacement.id
        AND prior.forge = $3
        AND LOWER(prior.repository) = LOWER($4)
        AND prior.program = $5
        AND prior.status IN ('queued', 'running')
        AND prior.head_sha <> replacement.head_sha
        AND prior_job.tenant = $1
        AND replacement_job.tenant = $1
        AND (prior_job.input_json::jsonb ->> 'prNumber') = $6
        AND (replacement_job.input_json::jsonb ->> 'prNumber') = $6
        AND prior_job.created_at < replacement_job.created_at
      ORDER BY prior_job.created_at ASC, prior.id ASC`,
    [
      input.orgId,
      input.replacementRunId,
      input.forge,
      input.repository,
      input.program,
      String(input.prNumber),
    ],
  );
  return rows.map((row) => row.id);
}
