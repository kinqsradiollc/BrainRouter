/**
 * A25-9a — durable repository-assurance integration fixture.
 *
 * A scratch Postgres database proves tenant-scoped idempotency, normalized
 * source/coverage/stage receipts, explicit partial state, and replacement-run
 * supersession against the real migration and query adapter.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type {
  AssuranceCoverage,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import { createTestStore } from "./helpers/pgTestStore.js";

const T0 = "2026-07-29T00:00:00.000Z";
const T1 = "2026-07-29T00:01:00.000Z";
const T2 = "2026-07-29T00:02:00.000Z";

function queuedRun(id: string, headSha: string): RepositoryAssuranceRun {
  return {
    id,
    repository: {
      forge: "github",
      slug: "owner/repository",
      repositoryId: "repo-1",
      defaultBranch: "main",
    },
    revision: { baseSha: "base", headSha, mergeBaseSha: "merge" },
    program: "security_review",
    policySnapshot: {
      id: "policy-1",
      policyHash: "policy-hash",
      organizationId: "org-1",
      program: "security_review",
      analyzers: [{ id: "analyzer-1", enabled: true, required: true }],
      packetLimits: { maxPackets: 10, maxPacketBytes: 10_000, maxFilesPerPacket: 10 },
      budgets: { maxModelCalls: 10, maxToolCalls: 20, maxDurationMs: 60_000 },
      redactionPolicyId: "redaction-1",
      publicationPolicyId: "publication-1",
      inlineFindingsEnabled: true,
      blockingEnabled: true,
      createdAt: T0,
    },
    sourceSnapshot: {
      id: `source-${id}`,
      revision: { baseSha: "base", headSha, mergeBaseSha: "merge" },
      status: "pending",
      fileCount: 0,
      textFileCount: 0,
      indexedFileCount: 0,
      unsupportedFileCount: 0,
      createdAt: T0,
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
      calculatedAt: T0,
    },
    stages: [],
    findings: [],
    status: "queued",
    createdAt: T0,
    updatedAt: T0,
  };
}

test("A25-9a persists idempotent, partial, and superseded assurance state", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    const job = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 7, headSha: "head-1" },
    }, { idGenerator: () => "job-1", now: T0 });
    const invalid = queuedRun("run-invalid", "head-1");
    (invalid.policySnapshot as unknown as Record<string, unknown>).access_token = "do-not-persist";
    await assert.rejects(
      store.createRepositoryAssuranceRun({ jobId: job.id, run: invalid }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        return message.includes("access_token") && !message.includes("do-not-persist");
      },
      "the Core validation boundary must reject secret-bearing records without echoing values",
    );
    const first = await store.createRepositoryAssuranceRun({
      jobId: job.id,
      run: queuedRun("run-1", "head-1"),
    });
    assert.equal(first.id, "run-1");
    assert.equal(first.status, "queued");

    const duplicateJob = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 7, headSha: "head-1" },
    }, { idGenerator: () => "job-duplicate", now: T0 });
    const duplicate = await store.createRepositoryAssuranceRun({
      jobId: duplicateJob.id,
      run: queuedRun("run-duplicate", "head-1"),
    });
    assert.equal(duplicate.id, "run-1", "equivalent exact-revision work must reuse the first durable run");

    await store.transitionRepositoryAssuranceRun({
      orgId: "org-1",
      runId: "run-1",
      status: "running",
      updatedAt: T1,
    });
    const runningStage: AssuranceStageReceipt = {
      id: "stage-1",
      stage: "checkout_inventory",
      status: "running",
      attempt: 1,
      startedAt: T1,
      inputRefs: ["revision:head-1"],
      outputRefs: [],
      limitationIds: [],
    };
    await store.recordRepositoryAssuranceStage("org-1", "run-1", runningStage);
    const partialStage = await store.recordRepositoryAssuranceStage("org-1", "run-1", {
      ...runningStage,
      status: "partial",
      completedAt: T2,
      durationMs: 60_000,
      outputRefs: ["inventory:partial"],
      limitationIds: ["limitation-1"],
      errorCode: "INDEX_UNAVAILABLE",
    });
    assert.equal(partialStage.status, "partial");

    const partialSource: SourceSnapshot = {
      ...first.sourceSnapshot,
      status: "partial",
      checkoutRef: "checkout:head-1",
      inventoryRef: "inventory:partial",
      fileCount: 12,
      textFileCount: 10,
      indexedFileCount: 6,
      unsupportedFileCount: 2,
      completedAt: T2,
      errorCode: "INDEX_UNAVAILABLE",
    };
    await store.updateRepositorySourceSnapshot("org-1", "run-1", partialSource);
    const partialCoverage: AssuranceCoverage = {
      status: "partial",
      filesTotal: 12,
      filesEligible: 10,
      filesAnalyzed: 6,
      changedFilesTotal: 3,
      changedFilesAnalyzed: 2,
      analyzers: [{
        analyzerId: "analyzer-1",
        state: "failed",
        supportedLanguages: ["typescript"],
        filesEligible: 10,
        filesAnalyzed: 6,
        diagnosticsProduced: 0,
        limitationIds: ["limitation-1"],
      }],
      limitations: [{
        id: "limitation-1",
        component: "analyzer-1",
        state: "failed",
        reasonCode: "INDEX_UNAVAILABLE",
        summary: "The repository index was unavailable.",
      }],
      calculatedAt: T2,
    };
    await store.updateRepositoryAssuranceCoverage("org-1", "run-1", partialCoverage);
    const partial = await store.transitionRepositoryAssuranceRun({
      orgId: "org-1",
      runId: "run-1",
      status: "partial",
      updatedAt: T2,
    });
    assert.equal(partial.status, "partial");
    assert.equal(partial.coverage.status, "partial");
    assert.equal(partial.sourceSnapshot.status, "partial");
    assert.deepEqual(partial.stages.map((stage) => stage.status), ["partial"]);
    await assert.rejects(
      store.transitionRepositoryAssuranceRun({
        orgId: "org-1",
        runId: "run-1",
        status: "completed",
      }),
      /partial -> completed is not allowed/,
    );

    const replacementJob = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 7, headSha: "head-2" },
    }, { idGenerator: () => "job-2", now: T2 });
    await store.createRepositoryAssuranceRun({
      jobId: replacementJob.id,
      run: queuedRun("run-2", "head-2"),
    });
    const superseded = await store.transitionRepositoryAssuranceRun({
      orgId: "org-1",
      runId: "run-1",
      status: "superseded",
      supersededByRunId: "run-2",
      updatedAt: T2,
    });
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.supersededByRunId, "run-2");
    assert.equal(await store.getRepositoryAssuranceRun("other-org", "run-1"), null);
    await assert.rejects(
      store.recordRepositoryAssuranceStage("org-1", "run-1", {
        ...runningStage,
        id: "stage-2",
        attempt: 2,
      }),
      /terminal assurance run/,
    );
  } finally {
    await cleanup();
  }
});

test("A25-9c3 selects only older active heads for the replacement PR", async () => {
  const { store, cleanup } = await createTestStore({ vecDim: 0 });
  try {
    const oldJob = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 7, headSha: "head-old" },
    }, { idGenerator: () => "job-old", now: T0 });
    await store.createRepositoryAssuranceRun({
      jobId: oldJob.id,
      run: queuedRun("run-old", "head-old"),
    });
    await store.transitionRepositoryAssuranceRun({
      orgId: "org-1",
      runId: "run-old",
      status: "running",
      updatedAt: T0,
    });

    const otherPrJob = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 8, headSha: "head-other" },
    }, { idGenerator: () => "job-other-pr", now: T1 });
    await store.createRepositoryAssuranceRun({
      jobId: otherPrJob.id,
      run: queuedRun("run-other-pr", "head-other"),
    });
    await store.transitionRepositoryAssuranceRun({
      orgId: "org-1",
      runId: "run-other-pr",
      status: "running",
      updatedAt: T1,
    });

    const replacementJob = await store.enqueueMemoryJob({
      kind: "pr-security-review",
      input: { orgId: "org-1", repo: "owner/repository", prNumber: 7, headSha: "head-new" },
    }, { idGenerator: () => "job-new", now: T2 });
    await store.createRepositoryAssuranceRun({
      jobId: replacementJob.id,
      run: queuedRun("run-new", "head-new"),
    });

    const replaceable = await store.listReplaceableRepositoryAssuranceRunIds({
      orgId: "org-1",
      forge: "github",
      repository: "owner/repository",
      prNumber: 7,
      program: "security_review",
      replacementRunId: "run-new",
    });
    assert.deepEqual(replaceable, ["run-old"]);
    assert.equal((await store.getRepositoryAssuranceRun("org-1", "run-other-pr"))?.status, "running");
  } finally {
    await cleanup();
  }
});
