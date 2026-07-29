/**
 * Contract tests for the SDK review client.
 *
 * These tests pin path encoding, trusted headers, cancellation, and lossless
 * projection of durable assurance state.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import type { ReviewJobDetailResponse } from "@kinqs/brainrouter-types";

import { BrainRouterClient } from "./client.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function detail(): ReviewJobDetailResponse {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    review: {
      id: "job/one",
      lens: "security",
      status: "completed",
      repo: "owner/repository",
      prNumber: 42,
      forge: "github",
      findings: 1,
      blocking: 1,
      findingsDetail: [],
      progress: [],
      skipped: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    assurance: {
      run: {
        id: "run-1",
        repository: { forge: "github", slug: "owner/repository" },
        revision: { headSha: "head-sha", baseSha: "base-sha" },
        program: "security_review",
        policySnapshot: {
          id: "policy-1",
          policyHash: "policy-hash",
          organizationId: "org-a",
          program: "security_review",
          analyzers: [{ id: "static-analysis", enabled: true, required: true }],
          packetLimits: { maxPackets: 4, maxPacketBytes: 50_000, maxFilesPerPacket: 20 },
          budgets: { maxModelCalls: 8, maxToolCalls: 30, maxDurationMs: 300_000 },
          redactionPolicyId: "redaction-v1",
          publicationPolicyId: "publication-v1",
          inlineFindingsEnabled: true,
          blockingEnabled: true,
          createdAt: now,
        },
        sourceSnapshot: {
          id: "source-1",
          revision: { headSha: "head-sha", baseSha: "base-sha" },
          status: "ready",
          fileCount: 2,
          textFileCount: 2,
          indexedFileCount: 2,
          unsupportedFileCount: 0,
          createdAt: now,
          completedAt: now,
        },
        coverage: {
          status: "complete",
          filesTotal: 2,
          filesEligible: 2,
          filesAnalyzed: 2,
          changedFilesTotal: 1,
          changedFilesAnalyzed: 1,
          analyzers: [],
          limitations: [],
          calculatedAt: now,
        },
        stages: [],
        findings: [{
          id: "finding-1",
          fingerprint: "fingerprint-1",
          state: "verified",
          severity: "high",
        }],
        status: "completed",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      findings: [{
        id: "finding-1",
        fingerprint: "fingerprint-1",
        program: "security_review",
        revisionSha: "head-sha",
        state: "verified",
        severity: "high",
        confidence: 0.94,
        title: "Authorization bypass",
        mechanism: "Missing ownership check",
        location: { path: "src/access.ts", line: 18 },
        evidence: [{
          id: "evidence-1",
          kind: "source",
          summary: "The update path does not constrain the owning organization.",
          revisionSha: "head-sha",
          location: { path: "src/access.ts", line: 18 },
          analyzerId: "static-analysis",
          createdAt: now,
        }],
        provenance: [{
          producerKind: "deterministic_analyzer",
          producerId: "static-analysis",
          policyHash: "policy-hash",
          createdAt: now,
        }],
        coverageLimitations: [],
        verifier: {
          state: "verified",
          verifierId: "independent-verifier",
          rationale: "The call path reaches an unscoped update.",
          evidenceRefs: ["evidence-1"],
          decidedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      }],
    },
    canRun: true,
  };
}

test("review detail preserves durable assurance state and trusted request scope", async () => {
  const expected = detail();
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    request = { url: String(input), init };
    return response(expected);
  }) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "", "access-token")
    .withActiveOrg("org-a");

  const actual = await client.reviews.getJob("job/one");

  assert.deepEqual(actual, expected);
  assert.equal(request?.url, "https://brain.example/api/admin/reviews/jobs/job%2Fone");
  assert.equal(request?.init.method, "GET");
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get("Authorization"), "Bearer access-token");
  assert.equal(headers.get("X-BrainRouter-Org"), "org-a");
});

test("review detail forwards cancellation to the shared transport", async () => {
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
  const controller = new AbortController();
  const request = new BrainRouterClient("https://brain.example", "api-key")
    .reviews.getJob("job-one", { signal: controller.signal });

  controller.abort();

  await assert.rejects(
    request,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
});
