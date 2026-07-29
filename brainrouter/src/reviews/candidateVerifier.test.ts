import { describe, expect, it, vi } from "vitest";
import type { AssuranceFinding, RepositoryAssuranceRun } from "@kinqs/brainrouter-types/review";
import { createBoundedCandidateVerifier } from "./candidateVerifier.js";

function run(): RepositoryAssuranceRun {
  return {
    id: "run-1",
    repository: { forge: "github", slug: "owner/repository" },
    revision: { headSha: "head-1" },
    program: "security_review",
    policySnapshot: {
      id: "policy-1",
      policyHash: "policy-hash",
      organizationId: "org-1",
      program: "security_review",
      analyzers: [],
      packetLimits: { maxPackets: 1, maxPacketBytes: 1, maxFilesPerPacket: 1 },
      budgets: { maxModelCalls: 1, maxToolCalls: 0, maxDurationMs: 60_000 },
      redactionPolicyId: "redaction-1",
      publicationPolicyId: "publication-1",
      inlineFindingsEnabled: true,
      blockingEnabled: true,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    sourceSnapshot: {
      id: "source-1",
      revision: { headSha: "head-1" },
      status: "ready",
      fileCount: 1,
      textFileCount: 1,
      indexedFileCount: 1,
      unsupportedFileCount: 0,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    coverage: {
      status: "complete",
      filesTotal: 1,
      filesEligible: 1,
      filesAnalyzed: 1,
      changedFilesTotal: 1,
      changedFilesAnalyzed: 1,
      analyzers: [],
      limitations: [],
      calculatedAt: "2026-07-29T00:00:00.000Z",
    },
    stages: [],
    findings: [],
    status: "running",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function finding(): AssuranceFinding {
  return {
    id: "finding-1",
    fingerprint: "fingerprint-1",
    program: "security_review",
    revisionSha: "head-1",
    state: "candidate",
    severity: "high",
    confidence: 0.8,
    title: "Source reaches sink",
    mechanism: "call path",
    location: { path: "src/sink.ts", line: 12 },
    evidence: [{
      id: "evidence-1",
      kind: "call_path",
      summary: "source reaches sink",
      revisionSha: "head-1",
      location: { path: "src/sink.ts", line: 12 },
      createdAt: "2026-07-29T00:00:00.000Z",
    }],
    provenance: [{
      producerKind: "deterministic_analyzer",
      producerId: "typescript-source-to-sink",
      policyHash: "policy-hash",
      createdAt: "2026-07-29T00:00:00.000Z",
    }],
    coverageLimitations: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

describe("bounded candidate verifier", () => {
  it("accepts only a structured disposition citing persisted exact-head evidence", async () => {
    const runModel = vi.fn(async () => JSON.stringify({
      state: "verified",
      rationale: "The call path is present in the supplied source.",
      evidenceRefs: ["evidence-1"],
    }));
    const verifier = createBoundedCandidateVerifier({
      llmRunner: { run: runModel },
      contextFor: () => "# src/sink.ts\nexecute(input)",
      now: () => "2026-07-29T00:00:01.000Z",
    });

    await expect(verifier.verify({ run: run(), finding: finding() })).resolves.toEqual({
      state: "verified",
      verifierId: "bounded-independent-review-verifier:v1",
      rationale: "The call path is present in the supplied source.",
      evidenceRefs: ["evidence-1"],
      decidedAt: "2026-07-29T00:00:01.000Z",
    });
    expect(runModel).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "assurance-verifier:run-1:finding-1",
      tool: expect.objectContaining({ name: "record_assurance_verification" }),
    }));
  });

  it.each([
    ["malformed output", { run: async () => "not json" }, () => "source"],
    ["unsupported evidence", {
      run: async () => JSON.stringify({
        state: "verified",
        rationale: "unsupported",
        evidenceRefs: ["missing"],
      }),
    }, () => "source"],
    ["provider failure", { run: async () => { throw new Error("offline"); } }, () => "source"],
    ["missing source context", { run: async () => "unused" }, () => null],
  ])("records %s as insufficient evidence", async (_label, llmRunner, contextFor) => {
    const verifier = createBoundedCandidateVerifier({
      llmRunner,
      contextFor,
      now: () => "2026-07-29T00:00:01.000Z",
    });

    await expect(verifier.verify({ run: run(), finding: finding() })).resolves.toMatchObject({
      state: "insufficient_evidence",
      evidenceRefs: ["evidence-1"],
    });
  });

  it("rejects stale evidence before a model call", async () => {
    const stale = finding();
    stale.evidence[0]!.revisionSha = "head-old";
    const runModel = vi.fn();
    const verifier = createBoundedCandidateVerifier({
      llmRunner: { run: runModel },
      contextFor: () => "source",
    });

    await expect(verifier.verify({ run: run(), finding: stale })).rejects.toThrow(
      /exact revision/,
    );
    expect(runModel).not.toHaveBeenCalled();
  });
});
