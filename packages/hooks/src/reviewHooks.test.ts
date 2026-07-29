/**
 * Request-lifecycle tests for durable review assurance hooks.
 *
 * These tests guard tenant/resource scope changes, cancellation, error
 * recovery, and preservation of partial lifecycle state.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { BrainRouterClient } from "@kinqs/brainrouter-sdk";
import type { ReviewJobDetailResponse } from "@kinqs/brainrouter-types";

import { useReviewAssurance } from "./useReviewAssurance.js";

const originalFetch = globalThis.fetch;
const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function detail(repo: string): ReviewJobDetailResponse {
  const now = "2026-07-29T00:00:00.000Z";
  return {
    review: {
      id: "job-one",
      lens: "security",
      status: "partial",
      repo,
      prNumber: 42,
      findings: 1,
      blocking: 0,
      findingsDetail: [],
      progress: [],
      skipped: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    assurance: {
      run: {
        id: "run-one",
        repository: { forge: "github", slug: repo },
        revision: { headSha: "head-sha" },
        program: "security_review",
        policySnapshot: {
          id: "policy-one",
          policyHash: "policy-hash",
          organizationId: "org-b",
          program: "security_review",
          analyzers: [],
          packetLimits: { maxPackets: 4, maxPacketBytes: 50_000, maxFilesPerPacket: 20 },
          budgets: { maxModelCalls: 8, maxToolCalls: 30, maxDurationMs: 300_000 },
          redactionPolicyId: "redaction-v1",
          publicationPolicyId: "publication-v1",
          inlineFindingsEnabled: true,
          blockingEnabled: true,
          createdAt: now,
        },
        sourceSnapshot: {
          id: "source-one",
          revision: { headSha: "head-sha" },
          status: "partial",
          fileCount: 3,
          textFileCount: 3,
          indexedFileCount: 2,
          unsupportedFileCount: 0,
          createdAt: now,
          completedAt: now,
        },
        coverage: {
          status: "partial",
          filesTotal: 3,
          filesEligible: 3,
          filesAnalyzed: 2,
          changedFilesTotal: 2,
          changedFilesAnalyzed: 1,
          analyzers: [],
          limitations: [{
            id: "limit-one",
            component: "index",
            state: "failed",
            reasonCode: "parser_unavailable",
            summary: "One file could not be indexed.",
            affectedPaths: ["src/legacy.ts"],
          }],
          calculatedAt: now,
        },
        stages: [{
          id: "stage-one",
          stage: "index",
          status: "partial",
          attempt: 1,
          inputRefs: ["source-one"],
          outputRefs: [],
          limitationIds: ["limit-one"],
          errorCode: "parser_unavailable",
        }],
        findings: [{
          id: "finding-one",
          fingerprint: "fingerprint-one",
          state: "insufficient_evidence",
          severity: "medium",
        }],
        status: "partial",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
      findings: [{
        id: "finding-one",
        fingerprint: "fingerprint-one",
        program: "security_review",
        revisionSha: "head-sha",
        state: "insufficient_evidence",
        severity: "medium",
        confidence: 0.55,
        title: "Unresolved authorization path",
        mechanism: "The available index does not cover one caller.",
        location: { path: "src/access.ts", line: 18 },
        evidence: [],
        provenance: [],
        coverageLimitations: [{
          id: "limit-one",
          component: "index",
          state: "failed",
          reasonCode: "parser_unavailable",
          summary: "One file could not be indexed.",
        }],
        verifier: {
          state: "insufficient_evidence",
          verifierId: "independent-verifier",
          rationale: "A required caller was outside the available index.",
          evidenceRefs: [],
          decidedAt: now,
        },
        createdAt: now,
        updatedAt: now,
      }],
    },
    canRun: true,
  };
}

type ReviewState = ReturnType<typeof useReviewAssurance>;

function requireState(state: ReviewState | undefined): ReviewState {
  assert.ok(state);
  return state;
}

function ReviewProbe(props: {
  client: BrainRouterClient;
  jobId: string;
  organizationScope: string;
  onState: (state: ReviewState) => void;
}) {
  const state = useReviewAssurance(
    props.client,
    props.jobId,
    props.organizationScope,
  );
  useEffect(() => props.onState(state), [props, state]);
  return null;
}

test("an organization switch aborts and clears an identically named review", async () => {
  const requests: Array<{
    headers: Headers;
    signal: AbortSignal;
    resolve: (value: Response) => void;
  }> = [];
  globalThis.fetch = ((_input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      requests.push({ headers: new Headers(init.headers), signal, resolve });
    })) as typeof fetch;
  const orgAClient = new BrainRouterClient("https://brain.example", "api-key")
    .withActiveOrg("org-a");
  const orgBClient = new BrainRouterClient("https://brain.example", "api-key")
    .withActiveOrg("org-b");
  let state: ReviewState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(ReviewProbe, {
      client: orgAClient,
      jobId: "job-one",
      organizationScope: "org-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });
  assert.equal(requests.length, 1);
  assert.equal(state?.isLoading, true);

  await act(async () => {
    renderer.update(createElement(ReviewProbe, {
      client: orgBClient,
      jobId: "job-one",
      organizationScope: "org-b",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].headers.get("X-BrainRouter-Org"), "org-b");
  assert.equal(requireState(state).review, null);

  await act(async () => {
    requests[1].resolve(response(detail("org-b/repository")));
    await flush();
  });
  assert.equal(requireState(state).review?.repo, "org-b/repository");
  assert.equal(requireState(state).assurance?.run.coverage.status, "partial");
  assert.equal(
    requireState(state).assurance?.findings[0].verifier?.state,
    "insufficient_evidence",
  );

  await act(async () => renderer.unmount());
});

test("a failed review query exposes the error and reloads the same scope", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? response({ error: "Assurance service unavailable" }, 503)
      : response(detail("owner/repository"));
  }) as typeof fetch;
  const client = new BrainRouterClient("https://brain.example", "api-key");
  let state: ReviewState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(ReviewProbe, {
      client,
      jobId: "job-one",
      organizationScope: "org-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });
  assert.equal(state?.isLoading, false);
  assert.equal(state?.error, "Assurance service unavailable");

  await act(async () => {
    state?.reload();
    await flush();
  });
  assert.equal(calls, 2);
  assert.equal(state?.error, null);
  assert.equal(state?.review?.repo, "owner/repository");

  await act(async () => renderer.unmount());
});

test("review assurance remains idle without a selected job", async () => {
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return response({});
  }) as typeof fetch;
  let state: ReviewState | undefined;
  let renderer: ReactTestRenderer;

  await act(async () => {
    renderer = create(createElement(ReviewProbe, {
      client: new BrainRouterClient("https://brain.example", "api-key"),
      jobId: "",
      organizationScope: "org-a",
      onState: (next) => {
        state = next;
      },
    }));
    await flush();
  });

  assert.equal(fetchCalls, 0);
  assert.equal(state?.detail, null);
  assert.equal(state?.isLoading, false);
  assert.equal(typeof state?.reload, "function");

  await act(async () => renderer.unmount());
});
