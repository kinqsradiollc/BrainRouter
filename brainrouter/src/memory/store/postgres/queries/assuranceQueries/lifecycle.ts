/**
 * Locked lifecycle transitions for durable assurance runs.
 *
 * Completion is fail-closed on source and coverage receipts; supersession must
 * point to a same-tenant replacement for the same repository and program.
 */

import type {
  AssuranceCoverage,
  AssuranceRunStatus,
  RepositoryAssuranceRun,
  SourceSnapshotStatus,
} from "@kinqs/brainrouter-types/review";
import type { Executor } from "../executor.js";
import {
  RUN_SELECT,
  type AssuranceRunRow,
  type AssuranceRunTransition,
} from "./contracts.js";
import { isAssuranceRunTransitionAllowed } from "./policy.js";
import { loadRun } from "./records.js";

export async function transitionRepositoryAssuranceRun(
  exec: Executor,
  input: AssuranceRunTransition,
): Promise<RepositoryAssuranceRun> {
  return exec.tx(async (client) => {
    const current = (await client.query<AssuranceRunRow>(
      `${RUN_SELECT} WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [input.orgId, input.runId],
    )).rows[0];
    if (!current) throw new Error(`Repository assurance run ${input.runId} was not found.`);
    if (!isAssuranceRunTransitionAllowed(current.status, input.status)) {
      throw new Error(`Repository assurance transition ${current.status} -> ${input.status} is not allowed.`);
    }
    if (current.status === input.status) return (await loadRun(client, input.orgId, input.runId))!;

    const updatedAt = input.updatedAt ?? new Date().toISOString();
    let supersededByRunId: string | null = null;
    let staleReason: string | null = null;
    if (input.status === "superseded") {
      if (!input.supersededByRunId || input.supersededByRunId === input.runId) {
        throw new Error("A superseded run requires a different replacement run.");
      }
      const replacement = (await client.query<AssuranceRunRow>(
        `${RUN_SELECT}
          WHERE org_id = $1 AND id = $2 AND forge = $3 AND repository = $4 AND program = $5`,
        [input.orgId, input.supersededByRunId, current.forge, current.repository, current.program],
      )).rows[0];
      if (!replacement) {
        throw new Error("The replacement assurance run must exist in the same tenant, repository, and program.");
      }
      supersededByRunId = replacement.id;
    } else if (input.status === "stale") {
      staleReason = input.staleReason?.trim() ?? "";
      if (!staleReason) throw new Error("A stale run requires a reason.");
    }

    if (input.status === "completed") {
      const receipts = (await client.query<{
        source_status: SourceSnapshotStatus;
        coverage_status: AssuranceCoverage["status"];
      }>(
        `SELECT source.status AS source_status, coverage.status AS coverage_status
           FROM repository_source_snapshots source
           JOIN repository_assurance_coverage coverage ON coverage.run_id = source.run_id
          WHERE source.run_id = $1`,
        [input.runId],
      )).rows[0];
      if (!receipts || receipts.source_status !== "ready" || receipts.coverage_status !== "complete") {
        throw new Error("A completed assurance run requires ready source and complete coverage receipts.");
      }
    }

    const terminal: AssuranceRunStatus[] = [
      "partial", "completed", "failed", "canceled", "superseded", "stale",
    ];
    const completedAt = terminal.includes(input.status)
      ? input.completedAt ?? updatedAt
      : null;
    await client.query(
      `UPDATE repository_assurance_runs
          SET status = $1, superseded_by_run_id = $2, stale_reason = $3,
              updated_at = $4, completed_at = $5
        WHERE org_id = $6 AND id = $7`,
      [input.status, supersededByRunId, staleReason, updatedAt, completedAt, input.orgId, input.runId],
    );
    return (await loadRun(client, input.orgId, input.runId))!;
  });
}
