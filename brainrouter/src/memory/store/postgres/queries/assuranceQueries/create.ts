/**
 * Atomic creation of normalized repository-assurance receipts.
 *
 * Equivalent requests race on a tenant-local semantic key and return the first
 * committed run. The memory-job row must already exist in the same tenant.
 */

import type {
  AssuranceCoverage,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import { validateRepositoryAssuranceRun } from "@kinqs/brainrouter-core/review";
import type { Executor } from "../executor.js";
import type { CreateRepositoryAssuranceRunInput, Queryable } from "./contracts.js";
import {
  normalizedRepositorySlug,
  repositoryAssuranceIdempotencyKey,
} from "./policy.js";
import { loadRun } from "./records.js";

function assertInitialRun(input: CreateRepositoryAssuranceRunInput): void {
  const { jobId, run } = input;
  const validation = validateRepositoryAssuranceRun(run);
  if (!validation.ok) {
    throw new Error(`Repository assurance run is invalid: ${validation.issues.join("; ")}.`);
  }
  if (!jobId.trim()) throw new Error("Repository assurance job id must be non-empty.");
  if (run.status !== "queued") throw new Error("A repository assurance run must be created in queued status.");
  if (!run.policySnapshot.organizationId.trim()) {
    throw new Error("Repository assurance organization id must be non-empty.");
  }
  if (run.findings.length > 0) {
    throw new Error("Finding persistence is unavailable until the finding-lineage adapter is active.");
  }
  if (
    run.sourceSnapshot.revision.headSha !== run.revision.headSha
    || run.sourceSnapshot.revision.baseSha !== run.revision.baseSha
    || run.sourceSnapshot.revision.mergeBaseSha !== run.revision.mergeBaseSha
  ) {
    throw new Error("Repository assurance source revision must match the run revision.");
  }
}

async function insertSource(queryable: Queryable, runId: string, source: SourceSnapshot): Promise<void> {
  await queryable.query(
    `INSERT INTO repository_source_snapshots
      (id, run_id, status, base_sha, head_sha, merge_base_sha, checkout_ref,
       inventory_ref, file_count, text_file_count, indexed_file_count,
       unsupported_file_count, byte_count, error_code, created_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      source.id, runId, source.status, source.revision.baseSha ?? null,
      source.revision.headSha, source.revision.mergeBaseSha ?? null,
      source.checkoutRef ?? null, source.inventoryRef ?? null, source.fileCount,
      source.textFileCount, source.indexedFileCount, source.unsupportedFileCount,
      source.byteCount ?? null, source.errorCode ?? null, source.createdAt,
      source.completedAt ?? null,
    ],
  );
}

async function insertCoverage(
  queryable: Queryable,
  runId: string,
  coverage: AssuranceCoverage,
): Promise<void> {
  await queryable.query(
    `INSERT INTO repository_assurance_coverage
      (run_id, status, files_total, files_eligible, files_analyzed,
       changed_files_total, changed_files_analyzed, analyzers_json,
       limitations_json, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
    [
      runId, coverage.status, coverage.filesTotal, coverage.filesEligible,
      coverage.filesAnalyzed, coverage.changedFilesTotal,
      coverage.changedFilesAnalyzed, JSON.stringify(coverage.analyzers),
      JSON.stringify(coverage.limitations), coverage.calculatedAt,
    ],
  );
}

export async function insertStage(
  queryable: Queryable,
  runId: string,
  stage: AssuranceStageReceipt,
): Promise<void> {
  await queryable.query(
    `INSERT INTO repository_assurance_stages
      (id, run_id, stage, status, attempt, started_at, completed_at, duration_ms,
       input_refs_json, output_refs_json, limitation_ids_json, error_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
    [
      stage.id, runId, stage.stage, stage.status, stage.attempt,
      stage.startedAt ?? null, stage.completedAt ?? null, stage.durationMs ?? null,
      JSON.stringify(stage.inputRefs), JSON.stringify(stage.outputRefs),
      JSON.stringify(stage.limitationIds), stage.errorCode ?? null,
    ],
  );
}

export async function createRepositoryAssuranceRun(
  exec: Executor,
  input: CreateRepositoryAssuranceRunInput,
): Promise<RepositoryAssuranceRun> {
  assertInitialRun(input);
  const { run, jobId } = input;
  const orgId = run.policySnapshot.organizationId;
  const idempotencyKey = repositoryAssuranceIdempotencyKey(run);
  return exec.tx(async (client) => {
    const job = (await client.query<{ org_id: string | null }>(
      `SELECT input_json::jsonb ->> 'orgId' AS org_id
         FROM memory_jobs WHERE id = $1 FOR SHARE`,
      [jobId],
    )).rows[0];
    if (!job) throw new Error(`Repository assurance job ${jobId} does not exist.`);
    if (job.org_id !== orgId) {
      throw new Error("Repository assurance job and policy organization do not match.");
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO repository_assurance_runs
        (id, job_id, org_id, idempotency_key, forge, repository, repository_id,
         default_branch, program, base_sha, head_sha, merge_base_sha,
         policy_snapshot_id, policy_hash, policy_json, status,
         superseded_by_run_id, stale_reason, created_at, updated_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,NULL,NULL,$17,$18,$19)
       ON CONFLICT (org_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        run.id, jobId, orgId, idempotencyKey, run.repository.forge,
        normalizedRepositorySlug(run), run.repository.repositoryId ?? null,
        run.repository.defaultBranch ?? null, run.program,
        run.revision.baseSha ?? null, run.revision.headSha,
        run.revision.mergeBaseSha ?? null, run.policySnapshot.id,
        run.policySnapshot.policyHash, JSON.stringify(run.policySnapshot),
        run.status, run.createdAt, run.updatedAt, run.completedAt ?? null,
      ],
    );
    if (inserted.rows[0]) {
      await insertSource(client, run.id, run.sourceSnapshot);
      await insertCoverage(client, run.id, run.coverage);
      for (const stage of run.stages) await insertStage(client, run.id, stage);
      return (await loadRun(client, orgId, run.id))!;
    }
    const existing = (await client.query<{ id: string }>(
      `SELECT id FROM repository_assurance_runs
        WHERE org_id = $1 AND idempotency_key = $2`,
      [orgId, idempotencyKey],
    )).rows[0];
    if (!existing) throw new Error("Repository assurance idempotency conflict could not be reconciled.");
    return (await loadRun(client, orgId, existing.id))!;
  });
}
