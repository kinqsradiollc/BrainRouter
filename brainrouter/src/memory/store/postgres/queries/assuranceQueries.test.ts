/**
 * Pure repository-assurance persistence policy fixtures.
 *
 * SQL behavior is covered by the Postgres integration fixture; these tests pin
 * the idempotency identity and lifecycle matrices without requiring a database.
 */

import { describe, expect, it, vi } from "vitest";
import type { RepositoryAssuranceRun } from "@kinqs/brainrouter-types/review";
import {
  getRepositoryAssuranceRunForJob,
  isAssuranceRunTransitionAllowed,
  isAssuranceFindingTransitionAllowed,
  isAssuranceStageTransitionAllowed,
  isSourceSnapshotTransitionAllowed,
  listRepositoryAssuranceFindings,
  listReplaceableRepositoryAssuranceRunIds,
  repositoryAssuranceIdempotencyKey,
} from "./assuranceQueries.js";

function queuedRun(): RepositoryAssuranceRun {
  return {
    id: "run-1",
    repository: { forge: "github", slug: "Owner/Repository" },
    revision: { baseSha: "base", headSha: "head", mergeBaseSha: "merge" },
    program: "security_review",
    policySnapshot: {
      id: "policy-1",
      policyHash: "policy-hash",
      organizationId: "org-1",
      program: "security_review",
      analyzers: [],
      packetLimits: { maxPackets: 1, maxPacketBytes: 1, maxFilesPerPacket: 1 },
      budgets: { maxModelCalls: 1, maxToolCalls: 1, maxDurationMs: 1 },
      redactionPolicyId: "redaction-1",
      publicationPolicyId: "publication-1",
      inlineFindingsEnabled: false,
      blockingEnabled: true,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    sourceSnapshot: {
      id: "source-1",
      revision: { baseSha: "base", headSha: "head", mergeBaseSha: "merge" },
      status: "pending",
      fileCount: 0,
      textFileCount: 0,
      indexedFileCount: 0,
      unsupportedFileCount: 0,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    coverage: {
      status: "unavailable",
      filesTotal: 0,
      filesEligible: 0,
      filesAnalyzed: 0,
      changedFilesTotal: 0,
      changedFilesAnalyzed: 0,
      analyzers: [],
      limitations: [],
      calculatedAt: "2026-07-29T00:00:00.000Z",
    },
    stages: [],
    findings: [],
    status: "queued",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

describe("repository assurance persistence policy", () => {
  it("keys equivalent work by tenant-local revision and policy semantics", () => {
    const first = queuedRun();
    const equivalent = {
      ...queuedRun(),
      id: "run-2",
      repository: { ...queuedRun().repository, slug: "owner/repository" },
      createdAt: "2026-07-29T01:00:00.000Z",
    };
    expect(repositoryAssuranceIdempotencyKey(equivalent)).toBe(
      repositoryAssuranceIdempotencyKey(first),
    );
    expect(repositoryAssuranceIdempotencyKey({
      ...first,
      revision: { ...first.revision, headSha: "new-head" },
    })).not.toBe(repositoryAssuranceIdempotencyKey(first));
    expect(repositoryAssuranceIdempotencyKey({
      ...first,
      policySnapshot: { ...first.policySnapshot, policyHash: "new-policy" },
    })).not.toBe(repositoryAssuranceIdempotencyKey(first));
    const repositoryIdentity = {
      ...first,
      repository: { ...first.repository, repositoryId: "repository-1" },
    };
    expect(repositoryAssuranceIdempotencyKey({
      ...repositoryIdentity,
      repository: { ...repositoryIdentity.repository, slug: "renamed/repository" },
    })).toBe(repositoryAssuranceIdempotencyKey(repositoryIdentity));
  });

  it("allows active progress and explicit invalidation but never revives terminal runs", () => {
    expect(isAssuranceRunTransitionAllowed("queued", "running")).toBe(true);
    expect(isAssuranceRunTransitionAllowed("running", "partial")).toBe(true);
    expect(isAssuranceRunTransitionAllowed("running", "completed")).toBe(true);
    expect(isAssuranceRunTransitionAllowed("completed", "superseded")).toBe(true);
    expect(isAssuranceRunTransitionAllowed("partial", "stale")).toBe(true);
    expect(isAssuranceRunTransitionAllowed("partial", "completed")).toBe(false);
    expect(isAssuranceRunTransitionAllowed("failed", "running")).toBe(false);
    expect(isAssuranceRunTransitionAllowed("superseded", "running")).toBe(false);
    expect(isAssuranceRunTransitionAllowed("stale", "queued")).toBe(false);
    expect(isAssuranceRunTransitionAllowed("running", "running")).toBe(true);
  });

  it("keeps stage attempts and source snapshots monotonic", () => {
    expect(isAssuranceStageTransitionAllowed("pending", "running")).toBe(true);
    expect(isAssuranceStageTransitionAllowed("running", "partial")).toBe(true);
    expect(isAssuranceStageTransitionAllowed("succeeded", "running")).toBe(false);
    expect(isAssuranceStageTransitionAllowed("failed", "succeeded")).toBe(false);
    expect(isSourceSnapshotTransitionAllowed("pending", "ready")).toBe(true);
    expect(isSourceSnapshotTransitionAllowed("ready", "stale")).toBe(true);
    expect(isSourceSnapshotTransitionAllowed("partial", "ready")).toBe(false);
    expect(isSourceSnapshotTransitionAllowed("stale", "pending")).toBe(false);
  });

  it("allows candidate disposition but never reopens a terminal finding", () => {
    expect(isAssuranceFindingTransitionAllowed("candidate", "verified")).toBe(true);
    expect(isAssuranceFindingTransitionAllowed("hotspot", "insufficient_evidence")).toBe(true);
    expect(isAssuranceFindingTransitionAllowed("insufficient_evidence", "validated")).toBe(true);
    expect(isAssuranceFindingTransitionAllowed("verified", "candidate")).toBe(false);
    expect(isAssuranceFindingTransitionAllowed("disputed", "verified")).toBe(false);
    expect(isAssuranceFindingTransitionAllowed("validated", "insufficient_evidence")).toBe(false);
  });

  it("selects only older active heads for the same tenant and PR", async () => {
    const rows = vi.fn(async (_sql: string, _params?: unknown[]) => [{ id: "run-old" }]);
    const result = await listReplaceableRepositoryAssuranceRunIds(
      { rows } as never,
      {
        orgId: "org-1",
        forge: "github",
        repository: "owner/repository",
        prNumber: 42,
        program: "security_review",
        replacementRunId: "run-new",
      },
    );
    expect(result).toEqual(["run-old"]);
    const [sql, params] = rows.mock.calls[0]!;
    expect(sql).toContain("prior.status IN ('queued', 'running')");
    expect(sql).toContain("prior.head_sha <> replacement.head_sha");
    expect(sql).toContain("prior_job.tenant = $1");
    expect(sql).toContain("prior_job.created_at < replacement_job.created_at");
    expect(sql).toContain("prior_job.input_json::jsonb ->> 'prNumber'");
    expect(params).toEqual([
      "org-1",
      "run-new",
      "github",
      "owner/repository",
      "security_review",
      "42",
    ]);
  });

  it("resolves a run by both tenant and worker job identity", async () => {
    const one = vi.fn(async (_sql: string, _params?: unknown[]) => null);
    await expect(getRepositoryAssuranceRunForJob(
      { one } as never,
      "org-1",
      "job-1",
    )).resolves.toBeNull();

    const [sql, params] = one.mock.calls[0]!;
    expect(sql).toContain("WHERE org_id = $1 AND job_id = $2");
    expect(sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(params).toEqual(["org-1", "job-1"]);
  });

  it("loads tenant- and run-bound finding dispositions with their evidence", async () => {
    const timestamp = "2026-07-29T00:00:00.000Z";
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM repository_assurance_findings")) {
        expect(params).toEqual(["org-1", "run-1"]);
        return {
          rows: [{
            org_id: "org-1",
            id: "finding-1",
            run_id: "run-1",
            fingerprint: "fingerprint-1",
            program: "security_review",
            revision_sha: "head-1",
            state: "verified",
            severity: "high",
            confidence: 0.9,
            title: "Unsafe input",
            mechanism: "Request input reaches a command sink.",
            location_json: { path: "src/index.ts", line: 4 },
            provenance_json: [{
              producerKind: "deterministic_analyzer",
              producerId: "parser-index",
              policyHash: "hash-1",
              createdAt: timestamp,
            }],
            coverage_limitations_json: [],
            verifier_json: {
              state: "verified",
              verifierId: "independent-verifier",
              rationale: "The exact call path supports the mechanism.",
              evidenceRefs: ["evidence-1"],
              decidedAt: timestamp,
            },
            cwe: "CWE-78",
            cve: null,
            remediation: "Use a non-shell API.",
            created_at: timestamp,
            updated_at: timestamp,
          }],
          rowCount: 1,
        };
      }
      expect(sql).toContain("finding_id = ANY($2::text[])");
      expect(params).toEqual(["org-1", ["finding-1"]]);
      return {
        rows: [{
          finding_id: "finding-1",
          id: "evidence-1",
          kind: "call_path",
          summary: "Request input reaches the command sink.",
          revision_sha: "head-1",
          location_json: { path: "src/index.ts", line: 4 },
          artifact_ref: null,
          analyzer_id: "parser-index",
          model_id: null,
          created_at: timestamp,
        }],
        rowCount: 1,
      };
    });
    const tx = async <T>(
      handler: (client: { query: typeof query }) => Promise<T>,
    ): Promise<T> => handler({ query });

    const findings = await listRepositoryAssuranceFindings(
      { tx } as never,
      "org-1",
      "run-1",
    );

    expect(findings).toEqual([expect.objectContaining({
      id: "finding-1",
      state: "verified",
      revisionSha: "head-1",
      evidence: [expect.objectContaining({
        id: "evidence-1",
        analyzerId: "parser-index",
      })],
      verifier: expect.objectContaining({
        state: "verified",
        evidenceRefs: ["evidence-1"],
      }),
    })]);
  });
});
