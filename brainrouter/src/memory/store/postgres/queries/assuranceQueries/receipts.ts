/**
 * Mutable source, coverage, and stage receipts for active assurance runs.
 *
 * Run/revision identity is immutable. Receipt updates are tenant-scoped,
 * monotonic where stateful, and forbidden after the run becomes terminal.
 */

import type {
  AssuranceCoverage,
  AssuranceRunStatus,
  AssuranceStageReceipt,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import type { Executor } from "../executor.js";
import {
  type CoverageRow,
  type SourceSnapshotRow,
  type StageRow,
} from "./contracts.js";
import { insertStage } from "./create.js";
import {
  isAssuranceStageTransitionAllowed,
  isSourceSnapshotTransitionAllowed,
} from "./policy.js";
import { coverageFromRow, sourceFromRow, stageFromRow } from "./records.js";

function assertActive(status: AssuranceRunStatus, receipt: string): void {
  if (!["queued", "running"].includes(status)) {
    throw new Error(`A terminal assurance run cannot change its ${receipt} receipts.`);
  }
}

export async function updateRepositorySourceSnapshot(
  exec: Executor,
  orgId: string,
  runId: string,
  source: SourceSnapshot,
): Promise<SourceSnapshot> {
  return exec.tx(async (client) => {
    const current = (await client.query<SourceSnapshotRow & { run_status: AssuranceRunStatus }>(
      `SELECT source.*, run.status AS run_status
         FROM repository_source_snapshots source
         JOIN repository_assurance_runs run ON run.id = source.run_id
        WHERE run.org_id = $1 AND source.run_id = $2 FOR UPDATE OF source`,
      [orgId, runId],
    )).rows[0];
    if (!current) throw new Error(`Repository assurance run ${runId} was not found.`);
    assertActive(current.run_status, "source");
    if (!isSourceSnapshotTransitionAllowed(current.status, source.status)) {
      throw new Error(`Source snapshot transition ${current.status} -> ${source.status} is not allowed.`);
    }
    if (source.id !== current.id || source.revision.headSha !== current.head_sha) {
      throw new Error("Source snapshot identity and exact revision are immutable.");
    }
    await client.query(
      `UPDATE repository_source_snapshots
          SET status = $1, checkout_ref = $2, inventory_ref = $3,
              file_count = $4, text_file_count = $5, indexed_file_count = $6,
              unsupported_file_count = $7, byte_count = $8, error_code = $9,
              completed_at = $10
        WHERE run_id = $11`,
      [
        source.status, source.checkoutRef ?? null, source.inventoryRef ?? null,
        source.fileCount, source.textFileCount, source.indexedFileCount,
        source.unsupportedFileCount, source.byteCount ?? null,
        source.errorCode ?? null, source.completedAt ?? null, runId,
      ],
    );
    const row = (await client.query<SourceSnapshotRow>(
      `SELECT id, status, base_sha, head_sha, merge_base_sha, checkout_ref,
              inventory_ref, file_count, text_file_count, indexed_file_count,
              unsupported_file_count, byte_count, error_code, created_at, completed_at
         FROM repository_source_snapshots WHERE run_id = $1`,
      [runId],
    )).rows[0]!;
    return sourceFromRow(row);
  });
}

export async function updateRepositoryAssuranceCoverage(
  exec: Executor,
  orgId: string,
  runId: string,
  coverage: AssuranceCoverage,
): Promise<AssuranceCoverage> {
  return exec.tx(async (client) => {
    const run = (await client.query<{ status: AssuranceRunStatus }>(
      `SELECT status FROM repository_assurance_runs
        WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, runId],
    )).rows[0];
    if (!run) throw new Error(`Repository assurance run ${runId} was not found.`);
    assertActive(run.status, "coverage");
    await client.query(
      `UPDATE repository_assurance_coverage
          SET status = $1, files_total = $2, files_eligible = $3,
              files_analyzed = $4, changed_files_total = $5,
              changed_files_analyzed = $6, analyzers_json = $7::jsonb,
              limitations_json = $8::jsonb, calculated_at = $9
        WHERE run_id = $10`,
      [
        coverage.status, coverage.filesTotal, coverage.filesEligible,
        coverage.filesAnalyzed, coverage.changedFilesTotal,
        coverage.changedFilesAnalyzed, JSON.stringify(coverage.analyzers),
        JSON.stringify(coverage.limitations), coverage.calculatedAt, runId,
      ],
    );
    const row = (await client.query<CoverageRow>(
      `SELECT status, files_total, files_eligible, files_analyzed,
              changed_files_total, changed_files_analyzed, analyzers_json,
              limitations_json, calculated_at
         FROM repository_assurance_coverage WHERE run_id = $1`,
      [runId],
    )).rows[0]!;
    return coverageFromRow(row);
  });
}

export async function recordRepositoryAssuranceStage(
  exec: Executor,
  orgId: string,
  runId: string,
  stage: AssuranceStageReceipt,
): Promise<AssuranceStageReceipt> {
  return exec.tx(async (client) => {
    const run = (await client.query<{ status: AssuranceRunStatus }>(
      `SELECT status FROM repository_assurance_runs
        WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, runId],
    )).rows[0];
    if (!run) throw new Error(`Repository assurance run ${runId} was not found.`);
    assertActive(run.status, "stage");
    const current = (await client.query<StageRow>(
      `SELECT id, stage, status, attempt, started_at, completed_at, duration_ms,
              input_refs_json, output_refs_json, limitation_ids_json, error_code
         FROM repository_assurance_stages
        WHERE run_id = $1 AND stage = $2 AND attempt = $3
        FOR UPDATE`,
      [runId, stage.stage, stage.attempt],
    )).rows[0];
    if (!current) {
      await insertStage(client, runId, stage);
      return stage;
    }
    if (current.id !== stage.id) {
      throw new Error("A stage attempt cannot change its receipt id.");
    }
    if (!isAssuranceStageTransitionAllowed(current.status, stage.status)) {
      throw new Error(`Assurance stage transition ${current.status} -> ${stage.status} is not allowed.`);
    }
    if (current.status !== stage.status) {
      await client.query(
        `UPDATE repository_assurance_stages
            SET status = $1, started_at = $2, completed_at = $3, duration_ms = $4,
                input_refs_json = $5::jsonb, output_refs_json = $6::jsonb,
                limitation_ids_json = $7::jsonb, error_code = $8
          WHERE run_id = $9 AND stage = $10 AND attempt = $11`,
        [
          stage.status, stage.startedAt ?? null, stage.completedAt ?? null,
          stage.durationMs ?? null, JSON.stringify(stage.inputRefs),
          JSON.stringify(stage.outputRefs), JSON.stringify(stage.limitationIds),
          stage.errorCode ?? null, runId, stage.stage, stage.attempt,
        ],
      );
    }
    const row = (await client.query<StageRow>(
      `SELECT id, stage, status, attempt, started_at, completed_at, duration_ms,
              input_refs_json, output_refs_json, limitation_ids_json, error_code
         FROM repository_assurance_stages
        WHERE run_id = $1 AND stage = $2 AND attempt = $3`,
      [runId, stage.stage, stage.attempt],
    )).rows[0]!;
    return stageFromRow(row);
  });
}
