/**
 * Pure repository-assurance persistence policy fixtures.
 *
 * SQL behavior is covered by the Postgres integration fixture; these tests pin
 * the idempotency identity and lifecycle matrices without requiring a database.
 */

import { describe, expect, it } from "vitest";
import type { RepositoryAssuranceRun } from "@kinqs/brainrouter-types/review";
import {
  isAssuranceRunTransitionAllowed,
  isAssuranceStageTransitionAllowed,
  isSourceSnapshotTransitionAllowed,
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
});
