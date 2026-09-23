/**
 * Assurance candidate normalization fixtures.
 *
 * These tests prove model output remains bounded, exact-head, candidate-only,
 * and unable to invent verifier evidence or cross a repository path boundary.
 */

import { describe, expect, it } from "vitest";
import { validateAssuranceFinding } from "@kinqs/brainrouter-core/review";
import type { RepositoryAssuranceRun } from "@kinqs/brainrouter-types/review";
import {
  mergeAssuranceCandidates,
  normalizeDeterministicCandidates,
  normalizeReviewCandidates,
} from "./reviewCandidateNormalization.js";

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
      budgets: { maxModelCalls: 1, maxToolCalls: 1, maxDurationMs: 1 },
      redactionPolicyId: "redaction-1",
      publicationPolicyId: "publication-1",
      inlineFindingsEnabled: true,
      blockingEnabled: true,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    sourceSnapshot: {
      id: "source-1",
      revision: { headSha: "head-1" },
      status: "partial",
      fileCount: 1,
      textFileCount: 1,
      indexedFileCount: 0,
      unsupportedFileCount: 0,
      createdAt: "2026-07-29T00:00:00.000Z",
    },
    coverage: {
      status: "partial",
      filesTotal: 1,
      filesEligible: 1,
      filesAnalyzed: 1,
      changedFilesTotal: 1,
      changedFilesAnalyzed: 1,
      analyzers: [],
      limitations: [{
        id: "diff-only",
        component: "repository-context",
        state: "unavailable",
        reasonCode: "DIFF_ONLY_FALLBACK",
        summary: "Only the diff was reviewed.",
      }],
      calculatedAt: "2026-07-29T00:00:01.000Z",
    },
    stages: [],
    findings: [],
    status: "running",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:01.000Z",
  };
}

describe("review candidate normalization", () => {
  it("creates exact-head candidate records without granting verifier authority", () => {
    const candidates = normalizeReviewCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      findings: [{
        file: "src/execute.ts",
        line: 12,
        endLine: 14,
        severity: "security",
        confidence: 92,
        title: "CWE-78 unsafe command construction",
        details: "Untrusted input may reach command execution.",
        suggestion: "Use an argument-safe execution API.",
      }],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      program: "security_review",
      revisionSha: "head-1",
      state: "candidate",
      severity: "high",
      confidence: 0.92,
      cwe: "CWE-78",
      location: { path: "src/execute.ts", line: 12, endLine: 14 },
      evidence: [],
      provenance: [{
        producerKind: "model",
        producerId: "llm-diff-review",
        policyHash: "policy-hash",
      }],
      coverageLimitations: [expect.objectContaining({ reasonCode: "DIFF_ONLY_FALLBACK" })],
    });
    expect(candidates[0]?.verifier).toBeUndefined();
    expect(validateAssuranceFinding(candidates[0]!)).toEqual({ ok: true, issues: [] });
  });

  it("drops unsafe paths and de-duplicates line-moved paraphrases by stable identity", () => {
    const candidates = normalizeReviewCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      findings: [{
        file: "../../../etc/passwd",
        severity: "high",
        title: "Unsafe command construction",
      }, {
        file: "src/execute.ts",
        line: 12,
        severity: "high",
        title: "Unsafe command construction",
      }, {
        file: "src/execute.ts",
        line: 40,
        severity: "critical",
        title: "Unsafe command construction",
      }],
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.location.path).toBe("src/execute.ts");
    expect(candidates[0]?.location.line).toBe(12);
  });

  it("caps candidate count and model-controlled text", () => {
    const candidates = normalizeReviewCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      findings: Array.from({ length: 501 }, (_, index) => ({
        file: `src/file-${index}.ts`,
        severity: "medium",
        title: `Finding ${index} ${"t".repeat(600)}`,
        details: "d".repeat(5_000),
        suggestion: "r".repeat(5_000),
      })),
    });

    expect(candidates).toHaveLength(500);
    expect(candidates[0]?.title).toHaveLength(500);
    expect(candidates[0]?.mechanism).toHaveLength(4_000);
    expect(candidates[0]?.remediation).toHaveLength(4_000);
  });

  it("normalizes exact-revision source-to-sink evidence without granting authority", () => {
    const candidates = normalizeDeterministicCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      assembly: {
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
              createdAt: "2026-07-29T00:00:01.000Z",
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
              createdAt: "2026-07-29T00:00:01.000Z",
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
          byteCount: 64,
          truncated: false,
          limitationIds: [],
        }],
        limitations: [],
        assembledAt: "2026-07-29T00:00:01.000Z",
      },
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      revisionSha: "head-1",
      program: "security_review",
      state: "candidate",
      severity: "high",
      location: { path: "src/sink.ts", line: 12 },
      evidence: [
        expect.objectContaining({ id: "evidence-1", revisionSha: "head-1" }),
        expect.objectContaining({ id: "evidence-2", revisionSha: "head-1" }),
      ],
      provenance: [expect.objectContaining({
        producerKind: "deterministic_analyzer",
        producerId: "typescript-source-to-sink",
      })],
    });
    expect(candidates[0]?.verifier).toBeUndefined();
    expect(validateAssuranceFinding(candidates[0]!)).toEqual({ ok: true, issues: [] });
  });

  it("ADR-039 D6 (S4) — renders the WHOLE hop chain in the mechanism, not just source→sink", () => {
    const candidates = normalizeDeterministicCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      assembly: {
        revisionSha: "head-1",
        indexRef: "index-1",
        packets: [{
          id: "packet-1",
          revisionSha: "head-1",
          program: "security_review",
          changed: [{ path: "src/req.ts", line: 3 }],
          context: [],
          sourceToSinkPaths: [{
            id: "path-1",
            mechanism: "data_flow",
            source: { path: "src/req.ts", line: 3 },
            sink: { path: "src/net/fetch.ts", line: 9 },
            evidenceRefs: [],
            hops: [
              { path: "src/req.ts", line: 3 },
              { path: "src/handler.ts", line: 14 },
              { path: "src/net/fetch.ts", line: 9 },
            ],
          }],
          artifactRefs: [],
          byteCount: 32,
          truncated: false,
          limitationIds: [],
        }],
        limitations: [],
        assembledAt: "2026-07-29T00:00:01.000Z",
      },
    });
    expect(candidates).toHaveLength(1);
    // The reader sees the full traversal — source → hop → sink — not a two-point summary.
    expect(candidates[0]?.mechanism).toBe(
      "data flow: src/req.ts:3 → src/handler.ts:14 → src/net/fetch.ts:9",
    );
  });

  it("rejects a deterministic assembly from a different revision", () => {
    expect(() => normalizeDeterministicCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      assembly: {
        revisionSha: "head-other",
        indexRef: "index-1",
        packets: [],
        limitations: [],
        assembledAt: "2026-07-29T00:00:01.000Z",
      },
    })).toThrow(/exact revision/);
  });

  it("merges same-fingerprint model and analyzer provenance without duplicate findings", () => {
    const model = normalizeReviewCandidates({
      run: run(),
      now: "2026-07-29T00:00:02.000Z",
      findings: [{
        file: "src/sink.ts",
        line: 12,
        severity: "high",
        title: "Parser-identified source-to-sink call path",
      }],
    })[0]!;
    const deterministic = {
      ...structuredClone(model),
      confidence: 0.8,
      evidence: [{
        id: "evidence-1",
        kind: "call_path" as const,
        summary: "source reaches sink",
        revisionSha: "head-1",
        location: { path: "src/sink.ts", line: 12 },
        analyzerId: "typescript-parser-index",
        createdAt: "2026-07-29T00:00:01.000Z",
      }],
      provenance: [{
        producerKind: "deterministic_analyzer" as const,
        producerId: "typescript-source-to-sink",
        policyHash: "policy-hash",
        createdAt: "2026-07-29T00:00:01.000Z",
      }],
    };

    const merged = mergeAssuranceCandidates([model, deterministic]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.evidence).toHaveLength(1);
    expect(merged[0]?.provenance.map((item) => item.producerKind)).toEqual([
      "model",
      "deterministic_analyzer",
    ]);
  });
});
