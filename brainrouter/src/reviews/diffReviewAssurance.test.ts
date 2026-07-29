import { describe, expect, it } from "vitest";
import type {
  AssuranceCoverage,
  AssuranceStageReceipt,
  RepositoryAssuranceRun,
  SourceSnapshot,
} from "@kinqs/brainrouter-types/review";
import {
  recordDiffReviewAssurance,
  startDiffReviewAssurance,
  type RecordDiffReviewAssuranceInput,
} from "./diffReviewAssurance.js";
import type { RepositoryAssurancePersistenceStore } from "./assuranceRunPort.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeAssuranceStore implements RepositoryAssurancePersistenceStore {
  readonly runs = new Map<string, RepositoryAssuranceRun>();
  readonly semanticIds = new Map<string, string>();

  async createRepositoryAssuranceRun(input: {
    jobId: string;
    run: RepositoryAssuranceRun;
  }): Promise<RepositoryAssuranceRun> {
    const run = clone(input.run);
    const key = [
      run.policySnapshot.organizationId,
      run.repository.forge,
      run.repository.slug.toLowerCase(),
      run.program,
      run.revision.headSha,
      run.policySnapshot.policyHash,
    ].join(":");
    const existingId = this.semanticIds.get(key);
    if (existingId) return clone(this.runs.get(existingId)!);
    this.semanticIds.set(key, run.id);
    this.runs.set(run.id, run);
    return clone(run);
  }

  async getRepositoryAssuranceRun(
    orgId: string,
    runId: string,
  ): Promise<RepositoryAssuranceRun | null> {
    const run = this.runs.get(runId);
    return run?.policySnapshot.organizationId === orgId ? clone(run) : null;
  }

  async transitionRepositoryAssuranceRun(input: {
    orgId: string;
    runId: string;
    status: RepositoryAssuranceRun["status"];
    updatedAt?: string;
    completedAt?: string;
    supersededByRunId?: string;
    staleReason?: string;
  }): Promise<RepositoryAssuranceRun> {
    const run = this.require(input.orgId, input.runId);
    run.status = input.status;
    run.updatedAt = input.updatedAt ?? run.updatedAt;
    if (input.completedAt) run.completedAt = input.completedAt;
    if (input.supersededByRunId) run.supersededByRunId = input.supersededByRunId;
    if (input.staleReason) run.staleReason = input.staleReason;
    this.runs.set(run.id, run);
    return clone(run);
  }

  async updateRepositorySourceSnapshot(
    orgId: string,
    runId: string,
    source: SourceSnapshot,
  ): Promise<SourceSnapshot> {
    const run = this.require(orgId, runId);
    if (source.id !== run.sourceSnapshot.id) throw new Error("source identity changed");
    run.sourceSnapshot = clone(source);
    return clone(source);
  }

  async updateRepositoryAssuranceCoverage(
    orgId: string,
    runId: string,
    coverage: AssuranceCoverage,
  ): Promise<AssuranceCoverage> {
    const run = this.require(orgId, runId);
    run.coverage = clone(coverage);
    return clone(coverage);
  }

  async recordRepositoryAssuranceStage(
    orgId: string,
    runId: string,
    stage: AssuranceStageReceipt,
  ): Promise<AssuranceStageReceipt> {
    const run = this.require(orgId, runId);
    run.stages = [
      ...run.stages.filter((item) =>
        item.stage !== stage.stage || item.attempt !== stage.attempt,
      ),
      clone(stage),
    ];
    return clone(stage);
  }

  private require(orgId: string, runId: string): RepositoryAssuranceRun {
    const run = this.runs.get(runId);
    if (!run || run.policySnapshot.organizationId !== orgId) throw new Error("run not found");
    return run;
  }
}

function input(
  store: FakeAssuranceStore,
  overrides: Partial<RecordDiffReviewAssuranceInput> = {},
): RecordDiffReviewAssuranceInput {
  let id = 0;
  let tick = 0;
  return {
    store,
    jobId: "job-1",
    review: {
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
    },
    program: "security_review",
    policy: {
      approveClean: false,
      blockOnFindings: true,
      reReviewOnPush: true,
      codeReviewTrigger: "manual",
    },
    result: {
      ok: true,
      findings: 2,
      posted: true,
      headSha: "head-1",
      coverage: {
        complete: true,
        totalParts: 2,
        reviewedParts: 2,
        failedParts: 0,
        unreviewedParts: 0,
        unrecordedFindings: 0,
      },
    },
    changedFiles: 4,
    maxDiffChars: 60_000,
    timeoutMs: 120_000,
    now: () => `2026-07-29T00:00:0${tick++}.000Z`,
    nextId: (kind) => `${kind}-${++id}`,
    ...overrides,
  };
}

describe("diff review assurance projection", () => {
  it("records exact-head diff-only coverage as partial and retries idempotently", async () => {
    const store = new FakeAssuranceStore();
    const request = input(store);
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    expect(session).not.toBeNull();
    expect(store.runs.get(session!.runId)?.status).toBe("running");

    const first = await session!.complete(result, changedFiles);
    expect(first).toMatchObject({
      status: "partial",
      revision: { headSha: "head-1" },
      sourceSnapshot: { status: "partial", errorCode: "DIFF_ONLY_FALLBACK" },
      coverage: {
        status: "partial",
        changedFilesTotal: 4,
        changedFilesAnalyzed: 4,
      },
    });
    expect(first?.coverage.limitations).toEqual([
      expect.objectContaining({ reasonCode: "DIFF_ONLY_FALLBACK" }),
    ]);
    expect(first?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "checkout_inventory", status: "partial" }),
      expect.objectContaining({ stage: "candidate_discovery", status: "partial" }),
    ]));

    const retried = await recordDiffReviewAssurance(input(store));
    expect(retried?.id).toBe(first?.id);
    expect(store.runs.size).toBe(1);
    expect(retried?.stages).toHaveLength(2);
  });

  it("records analyzer failure without claiming repository coverage", async () => {
    const store = new FakeAssuranceStore();
    const failed = await recordDiffReviewAssurance(input(store, {
      result: {
        ok: false,
        findings: 0,
        posted: false,
        headSha: "head-1",
        error: "provider unavailable",
      },
    }));
    expect(failed?.status).toBe("failed");
    expect(failed?.coverage).toMatchObject({
      status: "partial",
      filesAnalyzed: 0,
      changedFilesAnalyzed: 0,
    });
    expect(failed?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "candidate_discovery",
        status: "failed",
        errorCode: "DIFF_REVIEW_FAILED",
      }),
    ]));
  });

  it("does not persist a run without tenant and exact-head identity", async () => {
    const store = new FakeAssuranceStore();
    await expect(recordDiffReviewAssurance(input(store, {
      review: {
        installationId: "installation-1",
        repo: "owner/repository",
        prNumber: 42,
        headSha: "",
      },
      result: { ok: false, findings: 0, posted: false },
    }))).resolves.toBeNull();
    expect(store.runs.size).toBe(0);
  });
});
