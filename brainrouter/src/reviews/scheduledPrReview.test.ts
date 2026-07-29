/**
 * Scheduled-review composition fixtures.
 *
 * These tests prove the production job adapter transfers one exact-revision
 * checkout capability into the durable context campaign, forwards changed
 * anchors, observes cancellation, and preserves the executor's root failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthorizedAssessmentPolicy,
  buildDeepReviewPolicy,
} from "@kinqs/brainrouter-core/review";
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

const publicationGate = {
  status: "clean",
  blocked: false,
  cleanEligible: true,
  reason: "Full coverage permits a clean conclusion.",
  blockingFindingIds: [],
} as const;

const repositoryTarget = {
  id: "target-1",
  orgId: "org-1",
  createdBy: "user-1",
  kind: "repository",
  value: "owner/repository",
  normalizedValue: "owner/repository",
  label: null,
  authorizedAt: "2026-07-29T00:00:00.000Z",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
} as const;

function deepPolicy() {
  return buildDeepReviewPolicy({
    organizationId: "org-1",
    repository: { forge: "github", slug: "owner/repository" },
    program: "security_review",
    requestedBy: "user-1",
    telemetryThresholds: {
      program: "security_review",
      maxRepositoryFiles: 20_000,
      minIndexedFileRatio: 0.8,
      maxEstimatedModelCalls: 20,
      maxEstimatedToolCalls: 50,
      maxEstimatedDurationMs: 20 * 60_000,
      maxEstimatedUsd: 8,
      acceptedBy: "user-1",
      acceptedAt: "2026-07-30T00:00:00.000Z",
    },
    packetLimits: {
      maxPackets: 20,
      maxPacketBytes: 16_000,
      maxFilesPerPacket: 12,
    },
    budgets: {
      maxModelCalls: 15,
      maxToolCalls: 40,
      maxDurationMs: 15 * 60_000,
      maxUsd: 6,
    },
    now: "2026-07-30T00:00:00.000Z",
  });
}

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
      getPentestTarget: vi.fn(async () => repositoryTarget),
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
    const recordCandidates = vi.fn(async () => publicationGate);
    const complete = vi.fn(async () => ({ status: "completed" }));
    const session = {
      runId: "run-1",
      prepareContext,
      recordCandidates,
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
      const assuranceGate = await deps.onCandidatesReady?.({
        headSha: "head-1",
        currentHeadSha: "head-1",
        findings: [{
          file: "src/index.ts",
          severity: "high",
          confidence: 90,
          title: "Unsafe input",
        }],
        coverage: result.coverage,
        changedFiles: 3,
      });
      return { ...result, assuranceGate };
    });

    const ctx = context();
    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
    }, ctx, "security")).resolves.toEqual({ ...result, assuranceGate: publicationGate });

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
      llmRunner: ctx.llmRunner,
      repositoryContext: analysis,
    }));
    expect(prepareContext).toHaveBeenCalledWith([{ path: "src/index.ts", line: 4 }]);
    expect(recordCandidates).toHaveBeenCalledWith(
      "head-1",
      [expect.objectContaining({ file: "src/index.ts", confidence: 90 })],
      result.coverage,
      3,
      "head-1",
    );
    expect(complete).toHaveBeenCalledWith(
      { ...result, assuranceGate: publicationGate },
      3,
    );

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
      recordCandidates: vi.fn(),
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

  it("binds explicit deep-review policy and budgets into exact-context execution", async () => {
    const prepared = {
      text: "bounded whole-repository context",
      packetRefs: ["packet-1"],
      artifactRefs: ["artifact-1"],
    };
    const prepareContext = vi.fn(async () => prepared);
    const analysis = { source: "exact-analysis" };
    mocks.createAnalysis.mockReturnValue(analysis);
    mocks.start.mockResolvedValue({
      runId: "run-1",
      prepareContext,
      recordCandidates: vi.fn(async () => publicationGate),
      complete: vi.fn(async () => ({ status: "partial" })),
      fail: vi.fn(),
    });
    mocks.execute.mockImplementation(async (reviewInput, deps) => {
      expect(reviewInput.reviewMode).toBe("deep");
      expect(deps.executionBudget).toEqual({
        maxModelCalls: 15,
        maxDurationMs: 15 * 60_000,
      });
      await deps.onAssuranceReady?.({
        policy,
        headSha: "head-1",
        checkout: {
          remoteUrl: "https://github.com/owner/repository.git",
          takeAuthorizationHeader: () => "Authorization: Basic secret",
        },
      });
      return result;
    });

    const selected = deepPolicy();
    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
      requestedBy: "user-1",
      reviewMode: "deep",
      requestSource: "manual_api",
      deepReviewPolicy: selected,
    }, context(), "security")).resolves.toEqual(result);

    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      deepReview: {
        policy: selected,
        source: "manual_api",
      },
      repositoryContext: analysis,
    }));
  });

  it("rejects implicit, webhook, and scope-mismatched deep-review activation", async () => {
    const selected = deepPolicy();
    await expect(runScheduledPrReview({
      orgId: "org-1",
      repo: "owner/repository",
      prNumber: 42,
      deepReviewPolicy: selected,
    }, context(), "security")).rejects.toThrow(/cannot activate an ordinary diff review/);
    await expect(runScheduledPrReview({
      orgId: "org-1",
      repo: "owner/repository",
      prNumber: 42,
      requestedBy: "user-1",
      reviewMode: "deep",
      requestSource: "webhook",
      deepReviewPolicy: selected,
    }, context(), "security")).rejects.toThrow(/explicit manual/);
    await expect(runScheduledPrReview({
      orgId: "org-other",
      repo: "owner/repository",
      prNumber: 42,
      requestedBy: "user-1",
      reviewMode: "deep",
      requestSource: "manual_api",
      deepReviewPolicy: selected,
    }, context(), "security")).rejects.toThrow(/does not match/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects a PR pentest without a persisted assessment policy", async () => {
    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
    }, context(), "pentest")).rejects.toThrow(/persisted authorized-assessment policy/);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("revalidates the authorized repository target before a PR pentest", async () => {
    mocks.execute.mockResolvedValue(result);
    const assessmentPolicy = buildAuthorizedAssessmentPolicy(repositoryTarget, {
      scanMode: "code-review",
      now: "2026-07-29T01:00:00.000Z",
    });

    await expect(runScheduledPrReview({
      orgId: "org-1",
      installationId: "installation-1",
      repo: "owner/repository",
      prNumber: 42,
      headSha: "head-1",
      assessmentPolicy,
    }, context(), "pentest")).resolves.toEqual(result);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
});
