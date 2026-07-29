/**
 * Tenant-scoped repository-assurance finding and evidence persistence.
 *
 * A finding is pinned to one durable run, program, and exact revision. Evidence
 * remains normalized and verifier references are validated by Core before any
 * record can become publication- or gate-eligible.
 */

import type {
  AssuranceEvidenceRef,
  AssuranceFinding,
} from "@kinqs/brainrouter-types/review";
import { validateAssuranceFinding } from "@kinqs/brainrouter-core/review";
import { isDeepStrictEqual } from "node:util";
import type { Executor } from "../executor.js";
import type {
  EvidenceRow,
  FindingRow,
  Queryable,
  SaveRepositoryAssuranceFindingInput,
} from "./contracts.js";

const FINDING_SELECT = `
  SELECT org_id, id, run_id, fingerprint, program, revision_sha, state,
         severity, confidence, title, mechanism, location_json,
         provenance_json, coverage_limitations_json, verifier_json, cwe, cve,
         remediation, created_at, updated_at
    FROM repository_assurance_findings`;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonValue<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function evidenceFromRow(row: EvidenceRow): AssuranceEvidenceRef {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    revisionSha: row.revision_sha,
    ...(row.location_json ? { location: jsonValue(row.location_json) } : {}),
    ...(row.artifact_ref ? { artifactRef: row.artifact_ref } : {}),
    ...(row.analyzer_id ? { analyzerId: row.analyzer_id } : {}),
    ...(row.model_id ? { modelId: row.model_id } : {}),
    createdAt: iso(row.created_at),
  };
}

function findingFromRows(row: FindingRow, evidence: EvidenceRow[]): AssuranceFinding {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    program: row.program,
    revisionSha: row.revision_sha,
    state: row.state,
    severity: row.severity,
    confidence: Number(row.confidence),
    title: row.title,
    mechanism: row.mechanism,
    location: jsonValue(row.location_json),
    evidence: evidence.map(evidenceFromRow),
    provenance: jsonValue(row.provenance_json),
    coverageLimitations: jsonValue(row.coverage_limitations_json),
    ...(row.verifier_json ? { verifier: jsonValue(row.verifier_json) } : {}),
    ...(row.cwe ? { cwe: row.cwe } : {}),
    ...(row.cve ? { cve: row.cve } : {}),
    ...(row.remediation ? { remediation: row.remediation } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function loadFinding(
  queryable: Queryable,
  orgId: string,
  findingId: string,
): Promise<AssuranceFinding | null> {
  const row = (await queryable.query<FindingRow>(
    `${FINDING_SELECT} WHERE org_id = $1 AND id = $2`,
    [orgId, findingId],
  )).rows[0];
  if (!row) return null;
  const evidence = (await queryable.query<EvidenceRow>(
    `SELECT id, kind, summary, revision_sha, location_json, artifact_ref,
            analyzer_id, model_id, created_at
       FROM repository_assurance_evidence
      WHERE org_id = $1 AND finding_id = $2 ORDER BY created_at, id`,
    [orgId, findingId],
  )).rows;
  return findingFromRows(row, evidence);
}

function assertFindingBounds(finding: AssuranceFinding): void {
  if (finding.evidence.length > 128) {
    throw new Error("Repository assurance finding evidence exceeds the 128-record limit.");
  }
  if (finding.provenance.length > 64) {
    throw new Error("Repository assurance finding provenance exceeds the 64-record limit.");
  }
  if (finding.coverageLimitations.length > 128) {
    throw new Error("Repository assurance finding limitations exceed the 128-record limit.");
  }
  if (Buffer.byteLength(JSON.stringify(finding), "utf8") > 256 * 1024) {
    throw new Error("Repository assurance finding exceeds the 256 KiB persistence limit.");
  }
}

function immutableIdentityMatches(
  current: FindingRow,
  input: SaveRepositoryAssuranceFindingInput,
): boolean {
  const { finding, runId } = input;
  return current.run_id === runId
    && current.fingerprint === finding.fingerprint
    && current.program === finding.program
    && current.revision_sha === finding.revisionSha
    && iso(current.created_at) === iso(finding.createdAt);
}

export function isAssuranceFindingTransitionAllowed(
  from: AssuranceFinding["state"],
  to: AssuranceFinding["state"],
): boolean {
  if (from === to) return true;
  if (from === "candidate") {
    return ["hotspot", "verified", "disputed", "insufficient_evidence", "validated"].includes(to);
  }
  if (from === "hotspot" || from === "insufficient_evidence") {
    return ["verified", "disputed", "insufficient_evidence", "validated"].includes(to);
  }
  return false;
}

export async function getRepositoryAssuranceFinding(
  exec: Executor,
  orgId: string,
  runId: string,
  findingId: string,
): Promise<AssuranceFinding | null> {
  return exec.tx(async (client) => {
    const belongsToRun = (await client.query<{ id: string }>(
      `SELECT id FROM repository_assurance_findings
        WHERE org_id = $1 AND run_id = $2 AND id = $3`,
      [orgId, runId, findingId],
    )).rows[0];
    return belongsToRun ? loadFinding(client, orgId, findingId) : null;
  });
}

export async function saveRepositoryAssuranceFinding(
  exec: Executor,
  input: SaveRepositoryAssuranceFindingInput,
): Promise<AssuranceFinding> {
  const validation = validateAssuranceFinding(input.finding);
  if (!validation.ok) {
    throw new Error(`Repository assurance finding is invalid: ${validation.issues.join("; ")}.`);
  }
  assertFindingBounds(input.finding);
  return exec.tx(async (client) => {
    const run = (await client.query<{
      program: AssuranceFinding["program"];
      head_sha: string;
      status: string;
    }>(
      `SELECT program, head_sha, status
         FROM repository_assurance_runs
        WHERE org_id = $1 AND id = $2 FOR SHARE`,
      [input.orgId, input.runId],
    )).rows[0];
    if (!run) throw new Error(`Repository assurance run ${input.runId} was not found.`);
    if (run.program !== input.finding.program || run.head_sha !== input.finding.revisionSha) {
      throw new Error("Repository assurance finding must match its run program and exact revision.");
    }
    if (["failed", "canceled", "superseded", "stale"].includes(run.status)) {
      throw new Error(`Repository assurance run ${input.runId} cannot accept findings in ${run.status} state.`);
    }

    const current = (await client.query<FindingRow>(
      `${FINDING_SELECT} WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [input.orgId, input.finding.id],
    )).rows[0];
    if (current && !immutableIdentityMatches(current, input)) {
      throw new Error("Repository assurance finding identity cannot move between runs or revisions.");
    }
    if (current && !isAssuranceFindingTransitionAllowed(current.state, input.finding.state)) {
      throw new Error(
        `Repository assurance finding transition ${current.state} -> ${input.finding.state} is not allowed.`,
      );
    }
    if (current && ["verified", "validated", "disputed"].includes(current.state)) {
      const persisted = await loadFinding(client, input.orgId, input.finding.id);
      if (isDeepStrictEqual(persisted, input.finding)) return persisted!;
      throw new Error(`Repository assurance finding ${input.finding.id} has a terminal disposition.`);
    }

    const finding = input.finding;
    await client.query(
      `INSERT INTO repository_assurance_findings
        (org_id, id, run_id, fingerprint, program, revision_sha, state,
         severity, confidence, title, mechanism, location_json, provenance_json,
         coverage_limitations_json, verifier_json, cwe, cve, remediation,
         created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,
               $14::jsonb,$15::jsonb,$16,$17,$18,$19,$20)
       ON CONFLICT (org_id, id) DO UPDATE SET
         state = EXCLUDED.state,
         severity = EXCLUDED.severity,
         confidence = EXCLUDED.confidence,
         title = EXCLUDED.title,
         mechanism = EXCLUDED.mechanism,
         location_json = EXCLUDED.location_json,
         provenance_json = EXCLUDED.provenance_json,
         coverage_limitations_json = EXCLUDED.coverage_limitations_json,
         verifier_json = EXCLUDED.verifier_json,
         cwe = EXCLUDED.cwe,
         cve = EXCLUDED.cve,
         remediation = EXCLUDED.remediation,
         updated_at = EXCLUDED.updated_at`,
      [
        input.orgId, finding.id, input.runId, finding.fingerprint,
        finding.program, finding.revisionSha, finding.state, finding.severity,
        finding.confidence, finding.title, finding.mechanism,
        JSON.stringify(finding.location), JSON.stringify(finding.provenance),
        JSON.stringify(finding.coverageLimitations),
        finding.verifier ? JSON.stringify(finding.verifier) : null,
        finding.cwe ?? null, finding.cve ?? null, finding.remediation ?? null,
        finding.createdAt, finding.updatedAt,
      ],
    );
    await client.query(
      `DELETE FROM repository_assurance_evidence
        WHERE org_id = $1 AND finding_id = $2`,
      [input.orgId, finding.id],
    );
    for (const evidence of finding.evidence) {
      await client.query(
        `INSERT INTO repository_assurance_evidence
          (org_id, finding_id, id, kind, summary, revision_sha, location_json,
           artifact_ref, analyzer_id, model_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
        [
          input.orgId, finding.id, evidence.id, evidence.kind, evidence.summary,
          evidence.revisionSha,
          evidence.location ? JSON.stringify(evidence.location) : null,
          evidence.artifactRef ?? null, evidence.analyzerId ?? null,
          evidence.modelId ?? null, evidence.createdAt,
        ],
      );
    }
    return (await loadFinding(client, input.orgId, finding.id))!;
  });
}
