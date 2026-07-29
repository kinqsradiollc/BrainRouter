import type { AssessmentEvidenceCleanupResult } from "@kinqs/brainrouter-types/review";
import type { Executor } from "./executor.js";

const EMPTY_RESULT: AssessmentEvidenceCleanupResult = {
  jobsExpired: 0,
  evidenceRowsDeleted: 0,
  findingsScrubbed: 0,
  stageReceiptsScrubbed: 0,
  sourceReceiptsScrubbed: 0,
};

interface ExpiredAssessmentRow {
  id: string;
  retention_days: number;
}

/**
 * Expire persisted authorized-assessment evidence after its policy-defined
 * retention window. Queue identity, verdict counts, and finding identity remain
 * available for audit; raw evidence, detailed timelines, verifier payloads, and
 * artifact references do not.
 */
export async function expireAuthorizedAssessmentEvidence(
  exec: Executor,
  options?: { now?: string },
): Promise<AssessmentEvidenceCleanupResult> {
  const now = options?.now ?? new Date().toISOString();
  return exec.tx(async (client) => {
    const expired = (await client.query<ExpiredAssessmentRow>(
      `SELECT id,
              FLOOR((input_json::jsonb #>> '{assessmentPolicy,evidence,retentionDays}')::numeric)::integer
                 AS retention_days
         FROM memory_jobs
        WHERE kind IN ('domain-pentest', 'pr-pentest')
          AND status IN ('done', 'failed', 'cancelled')
          AND jsonb_typeof(input_json::jsonb #> '{assessmentPolicy,evidence,retentionDays}') = 'number'
          AND (input_json::jsonb #>> '{assessmentPolicy,evidence,retentionDays}')::numeric > 0
          AND updated_at::timestamptz
              + make_interval(days => LEAST(
                  FLOOR((input_json::jsonb #>> '{assessmentPolicy,evidence,retentionDays}')::numeric)::integer,
                  36500
                ))
              <= $1::timestamptz
          AND NOT (COALESCE(NULLIF(output_json, ''), '{}')::jsonb ? 'evidenceExpiredAt')
        ORDER BY updated_at, id
        FOR UPDATE SKIP LOCKED`,
      [now],
    )).rows;
    if (expired.length === 0) return { ...EMPTY_RESULT };

    const ids = expired.map((row) => row.id);
    const retentionDays = expired.map((row) => row.retention_days);
    const evidenceRowsDeleted = (await client.query(
      `DELETE FROM repository_assurance_evidence evidence
        USING repository_assurance_findings finding,
              repository_assurance_runs run
        WHERE evidence.org_id = finding.org_id
          AND evidence.finding_id = finding.id
          AND finding.run_id = run.id
          AND run.program = 'authorized_pentest'
          AND run.job_id = ANY($1::text[])`,
      [ids],
    )).rowCount ?? 0;
    const findingsScrubbed = (await client.query(
      `UPDATE repository_assurance_findings finding
          SET mechanism = 'Assessment evidence expired according to retention policy.',
              provenance_json = '[]'::jsonb,
              verifier_json = NULL,
              remediation = NULL
         FROM repository_assurance_runs run
        WHERE finding.run_id = run.id
          AND run.program = 'authorized_pentest'
          AND run.job_id = ANY($1::text[])
          AND (
            finding.mechanism <> 'Assessment evidence expired according to retention policy.'
            OR finding.provenance_json <> '[]'::jsonb
            OR finding.verifier_json IS NOT NULL
            OR finding.remediation IS NOT NULL
          )`,
      [ids],
    )).rowCount ?? 0;
    const stageReceiptsScrubbed = (await client.query(
      `UPDATE repository_assurance_stages stage
          SET input_refs_json = '[]'::jsonb,
              output_refs_json = '[]'::jsonb
         FROM repository_assurance_runs run
        WHERE stage.run_id = run.id
          AND run.program = 'authorized_pentest'
          AND run.job_id = ANY($1::text[])
          AND (
            stage.input_refs_json <> '[]'::jsonb
            OR stage.output_refs_json <> '[]'::jsonb
          )`,
      [ids],
    )).rowCount ?? 0;
    const sourceReceiptsScrubbed = (await client.query(
      `UPDATE repository_source_snapshots source
          SET checkout_ref = NULL,
              inventory_ref = NULL
         FROM repository_assurance_runs run
        WHERE source.run_id = run.id
          AND run.program = 'authorized_pentest'
          AND run.job_id = ANY($1::text[])
          AND (source.checkout_ref IS NOT NULL OR source.inventory_ref IS NOT NULL)`,
      [ids],
    )).rowCount ?? 0;
    const jobsExpired = (await client.query(
      `UPDATE memory_jobs job
          SET output_json = (
                (
                  COALESCE(NULLIF(job.output_json, ''), '{}')::jsonb
                  - 'findingsDetail'
                  - 'summary'
                  - 'workspaceRoot'
                  - 'sarifPath'
                )
                || jsonb_build_object(
                  'evidenceExpiredAt', $1::text,
                  'evidenceRetentionDays', expired.retention_days
                )
              )::text,
              progress_json = jsonb_build_array(jsonb_build_object(
                'ts', $1::text,
                'kind', 'retention',
                'msg', 'Detailed assessment evidence expired according to policy.'
              ))::text,
              error = CASE
                WHEN job.error IS NULL THEN NULL
                ELSE 'Assessment failure details expired according to retention policy.'
              END
         FROM unnest($2::text[], $3::integer[]) AS expired(id, retention_days)
        WHERE job.id = expired.id
          AND job.status IN ('done', 'failed', 'cancelled')`,
      [now, ids, retentionDays],
    )).rowCount ?? 0;

    return {
      jobsExpired,
      evidenceRowsDeleted,
      findingsScrubbed,
      stageReceiptsScrubbed,
      sourceReceiptsScrubbed,
    };
  });
}
