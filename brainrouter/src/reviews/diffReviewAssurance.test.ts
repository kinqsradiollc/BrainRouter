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
  type RepositoryAssuranceSupersessionStore,
} from "./diffReviewAssurance.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeAssuranceStore implements RepositoryAssuranceSupersessionStore {
  readonly runs = new Map<string, RepositoryAssuranceRun>();
  readonly semanticIds = new Map<string, string>();
  readonly runJobs = new Map<string, string>();
  readonly jobs = new Map<string, { order: number; prNumber: number }>([
    ["job-1", { order: 1, prNumber: 42 }],
  ]);
  private id = 0;

  readonly nextId = (kind: "run" | "source" | "stage"): string =>
    `${kind}-${++this.id}`;

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
    this.runJobs.set(run.id, input.jobId);
    return clone(run);
  }

  async listReplaceableRepositoryAssuranceRunIds(input: {
    orgId: string;
    forge: RepositoryAssuranceRun["repository"]["forge"];
    repository: string;
    prNumber: number;
    program: RepositoryAssuranceRun["program"];
    replacementRunId: string;
  }): Promise<string[]> {
    const replacement = this.runs.get(input.replacementRunId)!;
    const replacementJob = this.jobs.get(this.runJobs.get(replacement.id)!)!;
    return [...this.runs.values()]
      .filter((run) => {
        const job = this.jobs.get(this.runJobs.get(run.id)!)!;
        return run.id !== replacement.id
          && run.policySnapshot.organizationId === input.orgId
          && run.repository.forge === input.forge
          && run.repository.slug.toLowerCase() === input.repository.toLowerCase()
          && run.program === input.program
          && (run.status === "queued" || run.status === "running")
          && run.revision.headSha !== replacement.revision.headSha
          && job.prNumber === input.prNumber
          && replacementJob.prNumber === input.prNumber
          && job.order < replacementJob.order;
      })
      .map((run) => run.id);
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
    nextId: store.nextId,
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

  it("supersedes only an older active run for the same tenant, PR, and program", async () => {
    const store = new FakeAssuranceStore();
    const oldRequest = input(store, {
      review: {
        orgId: "org-1",
        installationId: "installation-1",
        repo: "owner/repository",
        prNumber: 42,
        headSha: "head-old",
      },
    });
    const { result: _oldResult, changedFiles: _oldFiles, ...oldStart } = oldRequest;
    const old = await startDiffReviewAssurance(oldStart);

    store.jobs.set("job-other-pr", { order: 2, prNumber: 99 });
    const otherRequest = input(store, {
      jobId: "job-other-pr",
      review: {
        orgId: "org-1",
        installationId: "installation-1",
        repo: "owner/repository",
        prNumber: 99,
        headSha: "head-other-pr",
      },
    });
    const { result: _otherResult, changedFiles: _otherFiles, ...otherStart } = otherRequest;
    const other = await startDiffReviewAssurance(otherStart);

    store.jobs.set("job-new", { order: 3, prNumber: 42 });
    const replacementRequest = input(store, {
      jobId: "job-new",
      review: {
        orgId: "org-1",
        installationId: "installation-1",
        repo: "owner/repository",
        prNumber: 42,
        headSha: "head-new",
      },
    });
    const {
      result: _replacementResult,
      changedFiles: _replacementFiles,
      ...replacementStart
    } = replacementRequest;
    const replacement = await startDiffReviewAssurance(replacementStart);

    expect(store.runs.get(old!.runId)).toMatchObject({
      status: "superseded",
      supersededByRunId: replacement!.runId,
    });
    expect(store.runs.get(other!.runId)?.status).toBe("running");
    expect(store.runs.get(replacement!.runId)?.status).toBe("running");
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
