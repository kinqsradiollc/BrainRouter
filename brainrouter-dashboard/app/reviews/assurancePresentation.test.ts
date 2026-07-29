/**
 * Fixtures for every non-authoritative assurance state shown to reviewers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AssuranceFinding,
  AssurancePublicationStatus,
  AssuranceRunStatus,
  ReviewAssuranceDto,
} from "@kinqs/brainrouter-types";

import { buildReviewAssurancePresentation } from "./assurancePresentation";

const NOW = "2026-07-29T00:00:00.000Z";

function publicationStatus(status: AssuranceRunStatus): AssurancePublicationStatus {
  if (status === "queued") return "running";
  if (status === "completed") return "blocked";
  return status;
}

function finding(
  state: AssuranceFinding["state"] = "verified",
): AssuranceFinding {
  return {
    id: "finding-one",
    fingerprint: "fingerprint-one",
    program: "security_review",
    revisionSha: "head-sha",
    state,
    severity: "high",
    confidence: 0.82,
    title: "Authorization boundary",
    mechanism: "A sensitive write lacks an ownership constraint.",
    location: { path: "src/access.ts", line: 18 },
    evidence: [{
      id: "evidence-one",
      kind: "source",
      summary: "The write query omits the organization identifier.",
      revisionSha: "head-sha",
      createdAt: NOW,
    }],
    provenance: [],
    coverageLimitations: [],
    verifier: {
      state: state === "candidate" || state === "hotspot" ? "insufficient_evidence" : state,
      verifierId: "independent-verifier",
      rationale: state === "insufficient_evidence"
        ? "A required caller was outside the available index."
        : "The exact source path confirms the candidate.",
      evidenceRefs: ["evidence-one"],
      decidedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function assurance(
  status: AssuranceRunStatus = "completed",
  selectedFinding: AssuranceFinding = finding(),
): ReviewAssuranceDto {
  return {
    publication: {
      schemaVersion: 1,
      status: publicationStatus(status),
      label: publicationStatus(status),
      conclusion: "failure",
      blocked: true,
      cleanEligible: false,
      reason: status === "partial"
        ? "Coverage is incomplete."
        : "Publication policy does not permit a clean conclusion.",
      blockingFindingIds: status === "completed" ? ["finding-one"] : [],
    },
    run: {
      id: "run-one",
      repository: { forge: "github", slug: "owner/repository" },
      revision: { headSha: "head-sha" },
      program: "security_review",
      policySnapshot: {
        id: "policy-one",
        policyHash: "policy-hash",
        organizationId: "org-a",
        program: "security_review",
        analyzers: [],
        packetLimits: { maxPackets: 4, maxPacketBytes: 50_000, maxFilesPerPacket: 20 },
        budgets: { maxModelCalls: 8, maxToolCalls: 30, maxDurationMs: 300_000 },
        redactionPolicyId: "redaction-v1",
        publicationPolicyId: "publication-v1",
        inlineFindingsEnabled: true,
        blockingEnabled: true,
        createdAt: NOW,
      },
      sourceSnapshot: {
        id: "source-one",
        revision: { headSha: "head-sha" },
        status: status === "partial" ? "partial" : "ready",
        fileCount: 3,
        textFileCount: 3,
        indexedFileCount: status === "partial" ? 2 : 3,
        unsupportedFileCount: 0,
        createdAt: NOW,
        completedAt: NOW,
      },
      coverage: {
        status: status === "partial" ? "partial" : "complete",
        filesTotal: 3,
        filesEligible: 3,
        filesAnalyzed: status === "partial" ? 2 : 3,
        changedFilesTotal: 2,
        changedFilesAnalyzed: status === "partial" ? 1 : 2,
        analyzers: [],
        limitations: status === "partial" ? [{
          id: "limit-one",
          component: "index",
          state: "failed",
          reasonCode: "parser_unavailable",
          summary: "One changed file could not be indexed.",
        }] : [],
        calculatedAt: NOW,
      },
      stages: [{
        id: "stage-one",
        stage: "candidate_verification",
        status: status === "partial" ? "partial" : "succeeded",
        attempt: 1,
        inputRefs: [],
        outputRefs: ["finding-one"],
        limitationIds: status === "partial" ? ["limit-one"] : [],
      }],
      findings: [{
        id: selectedFinding.id,
        fingerprint: selectedFinding.fingerprint,
        state: selectedFinding.state,
        severity: selectedFinding.severity,
      }],
      status,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: NOW,
    },
    findings: [selectedFinding],
  };
}

test("complete run preserves the exact blocking publication projection", () => {
  const view = buildReviewAssurancePresentation(assurance());

  assert.equal(view.status, "blocked");
  assert.equal(view.runStatus, "completed");
  assert.equal(view.statusTone, "danger");
  assert.equal(view.publication?.conclusion, "failure");
  assert.equal(view.coverage.status, "complete");
  assert.equal(view.coverage.files, "3/3 eligible files");
  assert.equal(view.authorityNotice, "Publication policy does not permit a clean conclusion.");
});

test("partial assurance exposes coverage gaps and partial stage receipts", () => {
  const view = buildReviewAssurancePresentation(assurance("partial"));

  assert.equal(view.statusTone, "danger");
  assert.equal(view.status, "partial");
  assert.equal(view.runStatus, "partial");
  assert.equal(view.coverage.tone, "warn");
  assert.deepEqual(view.coverage.limitations, ["One changed file could not be indexed."]);
  assert.equal(view.stages[0].status, "partial");
  assert.equal(view.authorityNotice, "Coverage is incomplete.");
});

test("stale assurance explains why its revision authority expired", () => {
  const value = assurance("stale");
  value.run.staleReason = "The pull request head changed.";

  const view = buildReviewAssurancePresentation(value);

  assert.equal(view.status, "stale");
  assert.equal(view.runStatus, "stale");
  assert.equal(view.statusTone, "danger");
  assert.equal(view.authorityNotice, "Publication policy does not permit a clean conclusion.");
});

test("superseded assurance points reviewers to the replacing run", () => {
  const value = assurance("superseded");
  value.run.supersededByRunId = "run-two";

  const view = buildReviewAssurancePresentation(value);

  assert.equal(view.status, "superseded");
  assert.equal(view.runStatus, "superseded");
});

test("unresolved findings retain evidence and verifier disposition", () => {
  const view = buildReviewAssurancePresentation(
    assurance("partial", finding("insufficient_evidence")),
  );

  assert.equal(view.findings[0].state, "insufficient evidence");
  assert.equal(view.findings[0].tone, "warn");
  assert.deepEqual(view.findings[0].evidence, [
    "The write query omits the organization identifier.",
  ]);
  assert.match(view.findings[0].verifier ?? "", /required caller was outside/);
});
