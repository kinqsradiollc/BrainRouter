/**
 * Repository-assurance adapter contracts and database row shapes.
 *
 * These types are private to the Postgres adapter except for the two mutation
 * inputs re-exported by the stable assuranceQueries façade.
 */

import type { QueryResultRow } from "pg";
import type {
  AssuranceCoverage,
  AssuranceEvidenceRef,
  AssuranceFinding,
  AssurancePolicySnapshot,
  AssuranceRunStatus,
  AssuranceStageReceipt,
  AssuranceStageStatus,
  RepositoryAssuranceRun,
  SourceSnapshotStatus,
} from "@kinqs/brainrouter-types/review";

export interface AssuranceRunRow extends QueryResultRow {
  id: string;
  job_id: string;
  org_id: string;
  forge: RepositoryAssuranceRun["repository"]["forge"];
  repository: string;
  repository_id: string | null;
  default_branch: string | null;
  program: RepositoryAssuranceRun["program"];
  base_sha: string | null;
  head_sha: string;
  merge_base_sha: string | null;
  policy_json: AssurancePolicySnapshot | string;
  status: AssuranceRunStatus;
  superseded_by_run_id: string | null;
  stale_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
}

export interface SourceSnapshotRow extends QueryResultRow {
  id: string;
  status: SourceSnapshotStatus;
  base_sha: string | null;
  head_sha: string;
  merge_base_sha: string | null;
  checkout_ref: string | null;
  inventory_ref: string | null;
  file_count: number | string;
  text_file_count: number | string;
  indexed_file_count: number | string;
  unsupported_file_count: number | string;
  byte_count: number | string | null;
  error_code: string | null;
  created_at: Date | string;
  completed_at: Date | string | null;
}

export interface CoverageRow extends QueryResultRow {
  status: AssuranceCoverage["status"];
  files_total: number | string;
  files_eligible: number | string;
  files_analyzed: number | string;
  changed_files_total: number | string;
  changed_files_analyzed: number | string;
  analyzers_json: AssuranceCoverage["analyzers"] | string;
  limitations_json: AssuranceCoverage["limitations"] | string;
  calculated_at: Date | string;
}

export interface StageRow extends QueryResultRow {
  id: string;
  stage: AssuranceStageReceipt["stage"];
  status: AssuranceStageStatus;
  attempt: number | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  duration_ms: number | string | null;
  input_refs_json: string[] | string;
  output_refs_json: string[] | string;
  limitation_ids_json: string[] | string;
  error_code: string | null;
}

export interface FindingRow extends QueryResultRow {
  org_id: string;
  id: string;
  run_id: string;
  fingerprint: string;
  program: AssuranceFinding["program"];
  revision_sha: string;
  state: AssuranceFinding["state"];
  severity: AssuranceFinding["severity"];
  confidence: number | string;
  title: string;
  mechanism: string;
  location_json: AssuranceFinding["location"] | string;
  provenance_json: AssuranceFinding["provenance"] | string;
  coverage_limitations_json: AssuranceFinding["coverageLimitations"] | string;
  verifier_json: AssuranceFinding["verifier"] | string | null;
  cwe: string | null;
  cve: string | null;
  remediation: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface FindingRefRow extends QueryResultRow {
  id: string;
  fingerprint: string;
  state: AssuranceFinding["state"];
  severity: AssuranceFinding["severity"];
}

export interface EvidenceRow extends QueryResultRow {
  id: string;
  kind: AssuranceEvidenceRef["kind"];
  summary: string;
  revision_sha: string;
  location_json: AssuranceEvidenceRef["location"] | string | null;
  artifact_ref: string | null;
  analyzer_id: string | null;
  model_id: string | null;
  created_at: Date | string;
}

export interface Queryable {
  query<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export interface CreateRepositoryAssuranceRunInput {
  jobId: string;
  run: RepositoryAssuranceRun;
}

export interface AssuranceRunTransition {
  orgId: string;
  runId: string;
  status: AssuranceRunStatus;
  updatedAt?: string;
  completedAt?: string;
  supersededByRunId?: string;
  staleReason?: string;
}

export interface ReplaceableAssuranceRunsInput {
  orgId: string;
  forge: RepositoryAssuranceRun["repository"]["forge"];
  repository: string;
  prNumber: number;
  program: RepositoryAssuranceRun["program"];
  replacementRunId: string;
}

export interface SaveRepositoryAssuranceFindingInput {
  orgId: string;
  runId: string;
  finding: AssuranceFinding;
}

export const RUN_SELECT = `
  SELECT id, job_id, org_id, forge, repository, repository_id, default_branch,
         program, base_sha, head_sha, merge_base_sha, policy_json, status,
         superseded_by_run_id, stale_reason, created_at, updated_at, completed_at
    FROM repository_assurance_runs`;
