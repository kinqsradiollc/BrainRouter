import { describe, expect, it, vi } from "vitest";
import type {
  AssuranceCoverage,
  AssuranceFinding,
  AssuranceImpactPacketAssembly,
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
import type { RepositoryContextAnalysisPorts } from "./repositoryContextAssurance.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

class FakeAssuranceStore implements RepositoryAssuranceSupersessionStore {
  readonly runs = new Map<string, RepositoryAssuranceRun>();
  readonly findings = new Map<string, AssuranceFinding>();
  readonly findingRuns = new Map<string, string>();
  readonly semanticIds = new Map<string, string>();
  readonly runJobs = new Map<string, string>();
  readonly jobs = new Map<string, { order: number; prNumber: number }>([
    ["job-1", { order: 1, prNumber: 42 }],
  ]);
  failCandidateDiscovery = false;
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

  async getRepositoryAssuranceFinding(
    orgId: string,
    runId: string,
    findingId: string,
  ): Promise<AssuranceFinding | null> {
    const finding = this.findings.get(findingId);
    const run = this.runs.get(runId);
    return finding
      && run?.policySnapshot.organizationId === orgId
      && this.findingRuns.get(findingId) === runId
      ? clone(finding)
      : null;
  }

  async saveRepositoryAssuranceFinding(input: {
    orgId: string;
    runId: string;
    finding: AssuranceFinding;
  }): Promise<AssuranceFinding> {
    const run = this.require(input.orgId, input.runId);
    if (
      input.finding.program !== run.program
      || input.finding.revisionSha !== run.revision.headSha
    ) {
      throw new Error("finding does not match run");
    }
    const finding = clone(input.finding);
    this.findings.set(finding.id, finding);
    this.findingRuns.set(finding.id, input.runId);
    run.findings = [
      ...run.findings.filter((item) => item.id !== finding.id),
      {
        id: finding.id,
        fingerprint: finding.fingerprint,
        state: finding.state,
        severity: finding.severity,
      },
    ];
    return clone(finding);
  }

  async recordRepositoryAssuranceStage(
    orgId: string,
    runId: string,
    stage: AssuranceStageReceipt,
  ): Promise<AssuranceStageReceipt> {
    if (this.failCandidateDiscovery && stage.stage === "candidate_discovery") {
      throw new Error("candidate receipt persistence failed");
    }
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

function repositoryContextAnalysis(overrides: {
  sourceFailure?: boolean;
  cancelAfterSource?: boolean;
  assembly?: AssuranceImpactPacketAssembly;
} = {}): RepositoryContextAnalysisPorts & {
  released: string[];
  impactCalls: string[][];
} {
  const released: string[] = [];
  const impactCalls: string[][] = [];
  let canceled = false;
  const assembly: AssuranceImpactPacketAssembly = overrides.assembly ?? {
    revisionSha: "head-1",
    indexRef: "index-1",
    packets: [{
      id: "packet-1",
      revisionSha: "head-1",
      program: "security_review",
      changed: [{ path: "src/route.ts", line: 10 }],
      context: [{
        relationship: "caller",
        distance: 1,
        evidence: {
          id: "evidence-1",
          kind: "call_path",
          summary: "handler calls route",
          revisionSha: "head-1",
          location: { path: "src/handler.ts", line: 20 },
          createdAt: "2026-07-29T00:00:00.000Z",
        },
      }],
      sourceToSinkPaths: [],
      artifactRefs: ["artifact-1"],
      byteCount: 32,
      truncated: false,
      limitationIds: [],
    }],
    limitations: [],
    assembledAt: "2026-07-29T00:00:00.000Z",
  };
  return {
    source: {
      prepare: async (request) => {
        if (overrides.sourceFailure) throw new Error("credential unavailable");
        if (overrides.cancelAfterSource) canceled = true;
        return {
          source: {
            id: "source-adapter",
            revision: request.revision,
            status: "ready",
            checkoutRef: "checkout-1",
            inventoryRef: "inventory-1",
            fileCount: 2,
            textFileCount: 2,
            indexedFileCount: 0,
            unsupportedFileCount: 0,
            byteCount: 128,
            createdAt: "2026-07-29T00:00:00.000Z",
            completedAt: "2026-07-29T00:00:00.000Z",
          },
          limitations: [],
        };
      },
      release: async (ref) => { released.push(ref); },
    },
    index: {
      update: async () => ({
        receipt: {
          id: "index-receipt-1",
          revisionSha: "head-1",
          indexRef: "index-1",
          status: "ready",
          analyzerId: "typescript-parser-index",
          analyzerVersion: "fixture",
          supportedLanguages: ["typescript", "javascript"],
          filesEligible: 2,
          filesIndexed: 2,
          symbolsIndexed: 3,
          relationshipsIndexed: 2,
          limitationIds: [],
          createdAt: "2026-07-29T00:00:00.000Z",
          completedAt: "2026-07-29T00:00:00.000Z",
        },
        limitations: [],
      }),
      release: async (ref) => { released.push(ref); },
    },
    impact: {
      assemble: async (request) => {
        impactCalls.push(request.changed.map((location) => location.path));
        return structuredClone(assembly);
      },
    },
    resolveArtifact: (ref) => ref === "artifact-1"
      ? { ref, content: "# src/handler.ts\nhandler();", byteCount: 32 }
      : null,
    releaseArtifacts: (refs) => { released.push(...refs); },
    isCancellationRequested: () => canceled,
    maxModelContextBytes: 4_096,
    released,
    impactCalls,
  };
}

function sourceToSinkAssembly(): AssuranceImpactPacketAssembly {
  return {
    revisionSha: "head-1",
    indexRef: "index-1",
    packets: [{
      id: "packet-1",
      revisionSha: "head-1",
      program: "security_review",
      changed: [{ path: "src/source.ts", line: 4 }],
      context: [{
        relationship: "source_to_sink",
        distance: 1,
        evidence: {
          id: "evidence-1",
          kind: "call_path",
          summary: "source reaches intermediary",
          revisionSha: "head-1",
          location: { path: "src/intermediary.ts", line: 8 },
          analyzerId: "typescript-parser-index",
          createdAt: "2026-07-29T00:00:00.000Z",
        },
      }, {
        relationship: "source_to_sink",
        distance: 2,
        evidence: {
          id: "evidence-2",
          kind: "call_path",
          summary: "intermediary reaches sink",
          revisionSha: "head-1",
          location: { path: "src/sink.ts", line: 12 },
          analyzerId: "typescript-parser-index",
          createdAt: "2026-07-29T00:00:00.000Z",
        },
      }],
      sourceToSinkPaths: [{
        id: "path-1",
        mechanism: "call_path",
        source: { path: "src/source.ts", line: 4 },
        sink: { path: "src/sink.ts", line: 12 },
        evidenceRefs: ["evidence-1", "evidence-2"],
      }],
      artifactRefs: ["artifact-1"],
      byteCount: 32,
      truncated: false,
      limitationIds: [],
    }],
    limitations: [],
    assembledAt: "2026-07-29T00:00:00.000Z",
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

  it("persists bounded exact-head model candidates before completing discovery", async () => {
    const store = new FakeAssuranceStore();
    const request = input(store);
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);

    await session!.recordCandidates(
      "head-1",
      [{
        file: "src/route.ts",
        line: 10,
        severity: "high",
        confidence: 94,
        title: "CWE-78 unsafe command construction",
        details: "Request input reaches command construction.",
      }],
      result.coverage!,
      changedFiles,
    );
    const completed = await session!.complete(result, changedFiles);
    const finding = [...store.findings.values()][0];

    expect(finding).toMatchObject({
      revisionSha: "head-1",
      state: "candidate",
      evidence: [],
      provenance: [expect.objectContaining({
        producerKind: "model",
        producerId: "llm-diff-review",
      })],
    });
    expect(finding?.verifier).toBeUndefined();
    expect(completed.findings).toEqual([
      expect.objectContaining({ id: finding?.id, state: "candidate" }),
    ]);
    expect(completed.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "candidate_discovery",
        outputRefs: expect.arrayContaining([finding?.id]),
      }),
    ]));
  });

  it("rejects candidates from a different revision", async () => {
    const store = new FakeAssuranceStore();
    const request = input(store);
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);

    await expect(session!.recordCandidates(
      "head-other",
      [],
      result.coverage!,
      changedFiles,
    )).rejects.toThrow(/exact revision/);
    expect(store.findings.size).toBe(0);
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

  it("rejects an excessive model-context budget before creating a durable run", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis();
    analysis.maxModelContextBytes = 256 * 1_024 + 1;
    const request = input(store, { repositoryContext: analysis });
    const { result: _result, changedFiles: _changedFiles, ...start } = request;

    await expect(startDiffReviewAssurance(start)).rejects.toThrow(
      /model-context limit must be an integer between/,
    );
    expect(store.runs.size).toBe(0);
  });

  it("rejects unsafe changed paths before invoking the impact adapter", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis();
    const request = input(store, { repositoryContext: analysis });
    const { result: _result, changedFiles: _changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);

    await expect(session!.prepareContext([{
      path: "../../../etc/passwd",
      line: 1,
    }])).resolves.toBeNull();
    expect(analysis.impactCalls).toEqual([]);
    expect(store.runs.get(session!.runId)?.coverage.limitations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reasonCode: "INVALID_CHANGED_SOURCE_PATH" }),
      ]),
    );
  });

  it("publishes exact source, parser index, bounded packets, coverage, and cleanup receipts", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis();
    const request = input(store, { repositoryContext: analysis });
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    const prompt = await session!.prepareContext([{ path: "src/route.ts", line: 10 }]);
    expect(prompt?.text).toContain("# src/handler.ts");

    const completed = await session!.complete(result, changedFiles);
    expect(completed).toMatchObject({
      status: "completed",
      sourceSnapshot: {
        status: "ready",
        indexedFileCount: 2,
      },
      coverage: {
        status: "complete",
        filesAnalyzed: 2,
        changedFilesAnalyzed: 1,
      },
    });
    expect(completed.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "checkout_inventory", attempt: 1, status: "succeeded" }),
      expect.objectContaining({ stage: "index", status: "succeeded" }),
      expect.objectContaining({ stage: "packet_assembly", status: "succeeded" }),
      expect.objectContaining({ stage: "candidate_discovery", status: "succeeded" }),
      expect.objectContaining({ stage: "cleanup", status: "succeeded" }),
    ]));
    expect(analysis.released).toEqual(["artifact-1", "index-1", "checkout-1"]);
  });

  it("persists parser source-to-sink paths as evidence-bearing candidates", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis({ assembly: sourceToSinkAssembly() });
    const request = input(store, {
      repositoryContext: analysis,
      llmRunner: {
        run: async () => JSON.stringify({
          state: "verified",
          rationale: "The exact source confirms the parser path.",
          evidenceRefs: ["evidence-1", "evidence-2"],
        }),
      },
    });
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    await session!.prepareContext([{ path: "src/source.ts", line: 4 }]);

    await session!.recordCandidates("head-1", [], result.coverage!, changedFiles);
    expect(store.runs.get(session!.runId)?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "candidate_discovery", status: "succeeded" }),
      expect.objectContaining({ stage: "candidate_verification", status: "succeeded" }),
    ]));
    const completed = await session!.complete(result, changedFiles);
    const finding = [...store.findings.values()][0];

    expect(finding).toMatchObject({
      revisionSha: "head-1",
      state: "verified",
      location: { path: "src/sink.ts", line: 12 },
      evidence: [
        expect.objectContaining({ id: "evidence-1" }),
        expect.objectContaining({ id: "evidence-2" }),
      ],
      provenance: [expect.objectContaining({
        producerKind: "deterministic_analyzer",
      })],
      verifier: {
        state: "verified",
        verifierId: "bounded-independent-review-verifier:v1",
        evidenceRefs: ["evidence-1", "evidence-2"],
      },
    });
    expect(completed.findings).toEqual([
      expect.objectContaining({ id: finding?.id, state: "verified" }),
    ]);
    expect(completed.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "candidate_verification",
        status: "succeeded",
        inputRefs: [finding?.id],
        outputRefs: [finding?.id],
      }),
    ]));
  });

  it("does not exceed the campaign's remaining verifier model-call budget", async () => {
    const store = new FakeAssuranceStore();
    const runModel = vi.fn(async () => JSON.stringify({
      state: "verified",
      rationale: "supported",
      evidenceRefs: ["evidence-1", "evidence-2"],
    }));
    const analysis = repositoryContextAnalysis({ assembly: sourceToSinkAssembly() });
    const request = input(store, {
      repositoryContext: analysis,
      llmRunner: { run: runModel },
    });
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    await session!.prepareContext([{ path: "src/source.ts", line: 4 }]);
    const durableRun = store.runs.get(session!.runId)!;
    durableRun.policySnapshot.budgets.maxModelCalls = result.coverage!.totalParts;

    await session!.recordCandidates("head-1", [], result.coverage!, changedFiles);

    expect(runModel).not.toHaveBeenCalled();
    expect([...store.findings.values()][0]?.state).toBe("candidate");
    expect(store.runs.get(session!.runId)?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: "candidate_verification",
        status: "partial",
        errorCode: "CANDIDATES_UNRESOLVED",
      }),
    ]));
  });

  it("records exact-source failure and an explicit second-attempt diff-only fallback", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis({ sourceFailure: true });
    const request = input(store, { repositoryContext: analysis });
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    await expect(session!.prepareContext([{ path: "src/route.ts", line: 10 }])).resolves.toBeNull();

    const partial = await session!.complete(result, changedFiles);
    expect(partial.status).toBe("partial");
    expect(partial.coverage.limitations.map((item) => item.reasonCode)).toEqual(expect.arrayContaining([
      "EXACT_SOURCE_UNAVAILABLE",
      "DIFF_ONLY_FALLBACK",
    ]));
    expect(partial.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "checkout_inventory", attempt: 1, status: "partial" }),
      expect.objectContaining({
        stage: "checkout_inventory",
        attempt: 2,
        status: "partial",
        errorCode: "DIFF_ONLY_FALLBACK",
      }),
      expect.objectContaining({ stage: "index", status: "partial" }),
      expect.objectContaining({ stage: "packet_assembly", status: "partial" }),
      expect.objectContaining({ stage: "cleanup", status: "succeeded" }),
    ]));
  });

  it("releases exact-source handles before recording a canceled campaign", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis({ cancelAfterSource: true });
    const request = input(store, { repositoryContext: analysis });
    const { result: _result, changedFiles: _changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    const canceled = store.runs.get(session!.runId)!;

    expect(canceled.status).toBe("canceled");
    expect(canceled.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "checkout_inventory", status: "succeeded" }),
      expect.objectContaining({ stage: "cleanup", status: "succeeded" }),
    ]));
    expect(canceled.stages.some((stage) => stage.stage === "index")).toBe(false);
    expect(analysis.released).toEqual(["checkout-1"]);
  });

  it("releases retained handles when a newer-head run supersedes the campaign", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis();
    const request = input(store, { repositoryContext: analysis });
    const { result: _result, changedFiles: _changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    const superseded = store.runs.get(session!.runId)!;
    superseded.status = "superseded";
    superseded.supersededByRunId = "run-new";

    await expect(session!.prepareContext([{ path: "src/route.ts", line: 10 }])).resolves.toBeNull();
    expect(analysis.released).toEqual(["index-1", "checkout-1"]);
  });

  it("releases retained handles when a later campaign receipt cannot be persisted", async () => {
    const store = new FakeAssuranceStore();
    const analysis = repositoryContextAnalysis();
    const request = input(store, { repositoryContext: analysis });
    const { result, changedFiles, ...start } = request;
    const session = await startDiffReviewAssurance(start);
    await session!.prepareContext([{ path: "src/route.ts", line: 10 }]);
    store.failCandidateDiscovery = true;

    await expect(session!.complete(result, changedFiles)).rejects.toThrow(
      /candidate receipt persistence failed/,
    );
    expect(analysis.released).toEqual(["artifact-1", "index-1", "checkout-1"]);
  });
});
