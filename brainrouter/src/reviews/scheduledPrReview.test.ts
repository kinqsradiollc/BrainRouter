/**
 * Scheduled-review composition fixtures.
 *
 * These tests prove the production job adapter transfers one exact-revision
 * checkout capability into the durable context campaign, forwards changed
 * anchors, observes cancellation, and preserves the executor's root failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobExecContext } from "../memory/scheduler/executors.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  start: vi.fn(),
  createAnalysis: vi.fn(),
}));

vi.mock("../integrations/prSecurityReview.js", () => ({
  runPrSecurityReview: mocks.execute,
  runPrCodeReview: mocks.execute,
  runPrPentest: mocks.execute,
}));

vi.mock("./diffReviewAssurance.js", () => ({
  startDiffReviewAssurance: mocks.start,
}));

vi.mock("./repositoryContextComposition.js", () => ({
  createRepositoryContextAnalysisPorts: mocks.createAnalysis,
}));

import { runScheduledPrReview } from "./scheduledPrReview.js";

const policy = {
  approveClean: false,
  blockOnFindings: true,
  reReviewOnPush: true,
  codeReviewTrigger: "manual",
} as const;

const result = {
  ok: true,
  findings: 0,
  posted: true,
  headSha: "head-1",
  coverage: {
    complete: true,
    totalParts: 1,
    reviewedParts: 1,
    failedParts: 0,
    unreviewedParts: 0,
    unrecordedFindings: 0,
  },
};

function context(status = "running"): JobExecContext {
  return {
    jobId: "job-1",
    llmRunner: { run: async () => "[]" },
    engine: {
      reviewAssignment: async () => ({ maxDiffChars: 20_000, timeoutMs: 90_000 }),
      findGithubAppByInstallation: async () => null,
      exportVault: async () => ({ dir: "", written: 0, unchanged: 0, total: 0 }),
      reconcilePendingBlackboard: async () => ({
        reconciled: 0,
        duplicate: 0,
        rejected: 0,
        items: [],
      }),
      commitBlackboardItem: async () => ({ committed: false }),
      summarizeBucket: async () => null,
      rechunkSources: async () => ({ rechunked: 0, skipped: 0, chunksWritten: 0 }),
      runRetrievalBenchmark: async () => ({
        summaryPath: null,
        statsByMode: {},
        sampled: 0,
        passed: true,
      }),
    },
    store: {
      getMemoryJob: vi.fn(async () => ({ status })),
      appendJobProgress: vi.fn(async () => undefined),
    } as unknown as JobExecContext["store"],
  };
}

describe("scheduled PR review repository-context composition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("activates exact context and forwards changed anchors into the durable campaign", async () => {
    const prepareContext = vi.fn(async () => ({
      text: "bounded context",
      packetRefs: ["packet-1"],
      artifactRefs: ["artifact-1"],
    }));
    const complete = vi.fn(async () => ({ status: "completed" }));
    const session = {
      runId: "run-1",
      prepareContext,
      complete,
      fail: vi.fn(),
    };
    const analysis = { source: "exact-analysis" };
    mocks.createAnalysis.mockReturnValue(analysis);
    mocks.start.mockResolvedValue(session);
    mocks.execute.mockImplementation(async (_input, deps) => {
      let authorizationHeader: string | null = "Authorization: Basic secret";
      await deps.onAssuranceReady?.({
        policy,
        headSha: "head-1",
        checkout: {
          remoteUrl: "https://github.com/owner/repository.git",
          takeAuthorizationHeader: () => {
            const value = authorizationHeader;
            authorizationHeader = null;
            if (!value) throw new Error("consumed");
            return value;
          },
        },
      });
      deps.onProgress?.({
        kind: "diff-fetched",
        msg: "diff fetched",
        data: { files: 3 },
      });
      await deps.prepareRepositoryContext?.({
        headSha: "head-1",
        changed: [{ path: "src/index.ts", line: 4 }],
      });
      return result;
    });

    const ctx = context();
    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
    }, ctx, "security")).resolves.toEqual(result);

    expect(mocks.createAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      maxDiffChars: 20_000,
      checkout: expect.objectContaining({
        remoteUrl: "https://github.com/owner/repository.git",
      }),
    }));
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-1",
      program: "security_review",
      maxDiffChars: 20_000,
      timeoutMs: 90_000,
      repositoryContext: analysis,
    }));
    expect(prepareContext).toHaveBeenCalledWith([{ path: "src/index.ts", line: 4 }]);
    expect(complete).toHaveBeenCalledWith(result, 3);

    const composition = mocks.createAnalysis.mock.calls[0]?.[0];
    await expect(composition.isCancellationRequested()).resolves.toBe(false);
    expect(ctx.store.getMemoryJob).toHaveBeenCalledWith("job-1");
  });

  it("preserves the executor failure when assurance failure projection also fails", async () => {
    const rootFailure = new Error("review execution failed");
    mocks.createAnalysis.mockReturnValue({ source: "exact-analysis" });
    mocks.start.mockResolvedValue({
      runId: "run-1",
      prepareContext: vi.fn(),
      complete: vi.fn(),
      fail: vi.fn(async () => {
        throw new Error("assurance projection failed");
      }),
    });
    mocks.execute.mockImplementation(async (_input, deps) => {
      await deps.onAssuranceReady?.({
        policy,
        headSha: "head-1",
        checkout: {
          remoteUrl: "https://github.com/owner/repository.git",
          takeAuthorizationHeader: () => "Authorization: Basic secret",
        },
      });
      throw rootFailure;
    });

    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
    }, context(), "security")).rejects.toBe(rootFailure);
  });
});
