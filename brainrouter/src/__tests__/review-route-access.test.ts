import express from "express";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedIntegration: vi.fn(),
  getMemberRole: vi.fn(),
  getDefaultOrgId: vi.fn(),
  resolveGithubAccountToken: vi.fn(),
  mintInstallationToken: vi.fn(),
  listReviewJobsForOrg: vi.fn(),
  listReviewJobSummariesForOrg: vi.fn(),
  listReviewAnalyticsForOrg: vi.fn(),
  getReviewLifecycleSummaryForOrg: vi.fn(),
  listReviewJobsForPr: vi.fn(),
  listReviewFindingsForOrg: vi.fn(),
  getMemoryJob: vi.fn(),
  getRepositoryAssuranceRunForJob: vi.fn(),
  listRepositoryAssuranceFindings: vi.fn(),
  getPentestTarget: vi.fn(),
  listMemoryJobs: vi.fn(),
  enqueueMemoryJob: vi.fn(),
}));

vi.mock("../memory/engine.js", () => ({
  memoryEngine: {
    getUserByApiKey: vi.fn((key: string) => key === "br_user"
      ? { userId: "user-1", isAdmin: false, email: "user@example.test", status: "active" }
      : null),
    tenancy: {
      getMemberRole: mocks.getMemberRole,
      getDefaultOrgId: mocks.getDefaultOrgId,
      ensurePersonalOrg: vi.fn(async () => ({ orgId: "org-1" })),
    },
    integrations: { getResolvedIntegration: mocks.getResolvedIntegration },
    emailAuth: {},
    store: {
      listReviewJobsForOrg: mocks.listReviewJobsForOrg,
      listReviewJobSummariesForOrg: mocks.listReviewJobSummariesForOrg,
      listReviewAnalyticsForOrg: mocks.listReviewAnalyticsForOrg,
      getReviewLifecycleSummaryForOrg: mocks.getReviewLifecycleSummaryForOrg,
      listReviewJobsForPr: mocks.listReviewJobsForPr,
      listReviewFindingsForOrg: mocks.listReviewFindingsForOrg,
      getMemoryJob: mocks.getMemoryJob,
      getRepositoryAssuranceRunForJob: mocks.getRepositoryAssuranceRunForJob,
      listRepositoryAssuranceFindings: mocks.listRepositoryAssuranceFindings,
      getPentestTarget: mocks.getPentestTarget,
      listMemoryJobs: mocks.listMemoryJobs,
      enqueueMemoryJob: mocks.enqueueMemoryJob,
    },
  },
}));

vi.mock("../connectors/githubAccountToken.js", () => ({
  resolveGithubAccountToken: mocks.resolveGithubAccountToken,
}));

vi.mock("@kinqs/brainrouter-core/track", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kinqs/brainrouter-core/track")>();
  return { ...actual, mintInstallationToken: mocks.mintInstallationToken };
});

import { reviewsRouter } from "../api/routes/admin/reviews.js";

type HttpResult = { status: number; body: any };

function getJson(url: URL, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function postJson(url: URL, headers: Record<string, string>, body: unknown): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = httpRequest(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(encoded)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

function githubResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("review route GitHub accessibility", () => {
  let server: ReturnType<express.Express["listen"]> | undefined;
  let baseUrl = "";

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getDefaultOrgId.mockResolvedValue("org-1");
    mocks.getMemberRole.mockResolvedValue("admin");
    mocks.getResolvedIntegration.mockResolvedValue(null);
    mocks.resolveGithubAccountToken.mockResolvedValue({
      accessToken: "sealed-account-token",
      login: "octocat",
      scope: "repo",
      connectedAt: "2026-07-14T00:00:00.000Z",
    });
    mocks.listReviewJobsForOrg.mockResolvedValue([]);
    mocks.listReviewJobSummariesForOrg.mockResolvedValue([]);
    mocks.listReviewAnalyticsForOrg.mockResolvedValue([]);
    mocks.getReviewLifecycleSummaryForOrg.mockResolvedValue({
      metrics: { issuesFound: 0, issuesFixed: 0, openIssues: 0, meanTimeToRemediateDays: null },
      severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      history: [], repositories: [], contributors: [],
    });
    mocks.listReviewJobsForPr.mockResolvedValue([]);
    mocks.listReviewFindingsForOrg.mockResolvedValue([]);
    mocks.getMemoryJob.mockResolvedValue(null);
    mocks.getRepositoryAssuranceRunForJob.mockResolvedValue(null);
    mocks.listRepositoryAssuranceFindings.mockResolvedValue([]);
    mocks.getPentestTarget.mockResolvedValue(null);
    mocks.listMemoryJobs.mockResolvedValue([]);
    mocks.enqueueMemoryJob.mockResolvedValue({ id: "review-job-1" });

    const app = express();
    app.use(express.json());
    app.use("/api/admin/reviews", reviewsRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server!.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  const headers = {
    Authorization: "Bearer br_user",
    "X-BrainRouter-Org": "org-1",
  };

  it("rejects unauthenticated issue reads", async () => {
    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/issues`), {});
    expect(response.status).toBe(401);
  });

  it("validates issue cursors before querying the store", async () => {
    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/issues?cursor=not-a-cursor`), headers);
    expect(response.status).toBe(400);
    expect(mocks.listReviewFindingsForOrg).not.toHaveBeenCalled();
  });

  it("returns compact filtered issues with provenance", async () => {
    mocks.listReviewFindingsForOrg.mockResolvedValue([{
      reviewId: "job-1", lens: "security", reviewStatus: "done", repo: "acme/widgets", prNumber: 7,
      issueStatus: "open", ordinal: 1, finding: { file: "src/a.ts", severity: "high", title: "Unsafe input" },
      createdAt: "2026-07-15T01:00:00.000Z", updatedAt: "2026-07-15T01:01:00.000Z", total: 1,
      severityCounts: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
    }]);
    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/issues?severity=high&repo=acme%2Fwidgets&q=unsafe`), headers);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 1,
      severity: { high: 1 },
      issues: [{ reviewId: "job-1", repo: "acme/widgets", prNumber: 7, finding: { title: "Unsafe input" } }],
    });
    expect(mocks.listReviewFindingsForOrg).toHaveBeenCalledWith("org-1", expect.objectContaining({ severity: "high", repo: "acme/widgets", search: "unsafe" }));
  });

  it("separates PR-review and security-test activity over a 12-month window", async () => {
    const now = new Date().toISOString();
    const base = {
      status: "completed", priority: 50, attempts: 1, maxAttempts: 3,
      runAfter: now, lockedAt: null, parentJobId: null, progress: [], error: null,
      createdAt: now, updatedAt: now,
    };
    mocks.listReviewAnalyticsForOrg.mockResolvedValue([
      {
        ...base, id: "review-1", kind: "pr-code-review",
        input: { orgId: "org-1", repo: "acme/widgets", prNumber: 42 },
        output: { findings: 1, blocking: 0, findingsDetail: [] },
      },
      {
        ...base, id: "test-1", kind: "domain-pentest",
        input: { orgId: "org-1", target: "https://example.test" },
        output: { findings: 0, blocking: 0, findingsDetail: [] },
      },
    ]);
    mocks.getReviewLifecycleSummaryForOrg.mockResolvedValue({
      metrics: { issuesFound: 2, issuesFixed: 1, openIssues: 1, meanTimeToRemediateDays: 1.5 },
      severity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      history: [{ date: now.slice(0, 10), critical: 0, high: 2, medium: 0, low: 0, open: 1, fixed: 1 }],
      repositories: [{ repository: "acme/widgets", findings: 2, addressed: 1 }],
      contributors: [{ login: "octocat", displayName: "Octo Cat", avatarUrl: null, prs: 1, authoredPrs: 1, commits: 2, findingsFixed: 1 }],
    });

    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/summary?days=365`), headers);
    expect(response.status).toBe(200);
    expect(response.body.periodDays).toBe(365);
    expect(response.body.metrics).toMatchObject({ prsReviewed: 1, pentests: 1, issuesFound: 2, issuesFixed: 1, fixRate: 50, meanTimeToRemediateDays: 1.5 });
    expect(response.body.history.at(-1)).toMatchObject({ activity: 2, prReviews: 1, tests: 1 });
    expect(response.body.repositories).toEqual([{ repository: "acme/widgets", prs: 1, findings: 2, addressed: 1 }]);
    expect(response.body.contributors[0]).toMatchObject({ login: "octocat", findingsFixed: 1 });
  });

  it("polls PR activity without any GitHub request", async () => {
    mocks.listReviewJobsForPr.mockResolvedValue([{
      id: "job-1", kind: "pr-security-review", status: "running", priority: 50, attempts: 0, maxAttempts: 3,
      runAfter: "2026-07-15T00:00:00.000Z", lockedAt: null, parentJobId: null,
      input: { orgId: "org-1", repo: "acme/widgets", prNumber: 7 }, output: null,
      progress: [{ ts: "2026-07-15T00:00:01.000Z", kind: "llm-started", msg: "Review model started" }],
      error: null, createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:01.000Z",
    }]);
    const githubFetch = vi.fn(async () => { throw new Error("activity must be local"); });
    vi.stubGlobal("fetch", githubFetch);
    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/prs/acme/widgets/7/activity`), headers);
    expect(response.status).toBe(200);
    expect(response.body.reviews[0]).toMatchObject({ id: "job-1", status: "running" });
    expect(githubFetch).not.toHaveBeenCalled();
  });

  it("projects one tenant-scoped durable assurance state on review detail", async () => {
    const timestamp = "2026-07-29T00:00:00.000Z";
    mocks.getMemoryJob.mockResolvedValue({
      id: "job-1",
      kind: "pr-security-review",
      status: "completed",
      priority: 50,
      attempts: 1,
      maxAttempts: 3,
      runAfter: timestamp,
      lockedAt: null,
      parentJobId: null,
      input: {
        orgId: "org-1",
        repo: "acme/widgets",
        prNumber: 7,
        headSha: "head-1",
      },
      output: {
        findings: 1,
        blocking: 0,
        posted: true,
        assuranceGate: {
          status: "advisory",
          blocked: false,
          cleanEligible: false,
          reason: "One candidate requires disposition.",
          blockingFindingIds: [],
        },
      },
      progress: [],
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    mocks.getRepositoryAssuranceRunForJob.mockResolvedValue({
      id: "run-1",
      repository: { forge: "github", slug: "acme/widgets" },
      revision: { headSha: "head-1" },
      program: "security_review",
      policySnapshot: {
        id: "policy-1",
        policyHash: "hash-1",
        organizationId: "org-1",
        program: "security_review",
        analyzers: [],
        packetLimits: { maxPackets: 1, maxPacketBytes: 1, maxFilesPerPacket: 1 },
        budgets: { maxModelCalls: 1, maxToolCalls: 0, maxDurationMs: 1 },
        redactionPolicyId: "redaction-1",
        publicationPolicyId: "publication-1",
        inlineFindingsEnabled: true,
        blockingEnabled: true,
        createdAt: timestamp,
      },
      sourceSnapshot: {
        id: "source-1",
        revision: { headSha: "head-1" },
        status: "ready",
        fileCount: 1,
        textFileCount: 1,
        indexedFileCount: 1,
        unsupportedFileCount: 0,
        createdAt: timestamp,
        completedAt: timestamp,
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
        calculatedAt: timestamp,
      },
      stages: [],
      findings: [{
        id: "finding-1",
        fingerprint: "fingerprint-1",
        state: "insufficient_evidence",
        severity: "high",
      }],
      status: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: timestamp,
    });
    mocks.listRepositoryAssuranceFindings.mockResolvedValue([{
      id: "finding-1",
      fingerprint: "fingerprint-1",
      program: "security_review",
      revisionSha: "head-1",
      state: "insufficient_evidence",
      severity: "high",
      confidence: 0.8,
      title: "Unverified unsafe input",
      mechanism: "The available evidence did not prove the reported flow.",
      location: { path: "src/index.ts", line: 4 },
      evidence: [],
      provenance: [{
        producerKind: "model",
        producerId: "review-model",
        policyHash: "hash-1",
        createdAt: timestamp,
      }],
      coverageLimitations: [],
      verifier: {
        state: "insufficient_evidence",
        verifierId: "independent-verifier",
        rationale: "No supported evidence reference was available.",
        evidenceRefs: [],
        decidedAt: timestamp,
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    }]);

    const response = await getJson(
      new URL(`${baseUrl}/api/admin/reviews/jobs/job-1`),
      headers,
    );

    expect(response.status).toBe(200);
    expect(response.body.assurance).toMatchObject({
      run: {
        id: "run-1",
        status: "completed",
        coverage: { status: "complete" },
        findings: [{ id: "finding-1", state: "insufficient_evidence" }],
      },
      findings: [{
        id: "finding-1",
        state: "insufficient_evidence",
        verifier: { state: "insufficient_evidence" },
      }],
      publication: {
        schemaVersion: 1,
        status: "advisory",
        label: "advisory",
        conclusion: "neutral",
        blocked: false,
        cleanEligible: false,
        reason: "One candidate requires disposition.",
        blockingFindingIds: [],
      },
    });
    expect(mocks.getRepositoryAssuranceRunForJob).toHaveBeenCalledWith(
      "org-1",
      "job-1",
    );
    expect(mocks.listRepositoryAssuranceFindings).toHaveBeenCalledWith(
      "org-1",
      "run-1",
    );
  });

  it("loads PR detail through the signed-in GitHub account when no App integration exists", async () => {
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sealed-account-token");
      if (url === "https://api.github.com/repos/acme/widgets") return githubResponse(200, { id: 1 });
      if (url === "https://api.github.com/repos/acme/widgets/pulls/7") {
        return githubResponse(200, {
          number: 7,
          title: "Fix account review access",
          user: { login: "octocat" },
          head: { ref: "fix/review-access", sha: "abc123" },
          html_url: "https://github.com/acme/widgets/pull/7",
        });
      }
      if (url === "https://api.github.com/repos/acme/widgets/commits/abc123/check-runs") {
        return githubResponse(200, { check_runs: [{ id: 99, name: "CI" }] });
      }
      return githubResponse(404, {});
    });
    vi.stubGlobal("fetch", githubFetch);

    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/prs/acme/widgets/7`), headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      pr: {
        repo: "acme/widgets",
        number: 7,
        title: "Fix account review access",
        availability: {
          accountConnected: true,
          repositoryAccessible: true,
          autoReviewEnabled: false,
        },
        checks: [{ id: 99, name: "CI" }],
      },
      canRun: true,
    });
    expect(JSON.stringify(response.body)).not.toContain("sealed-account-token");
  });

  it("lists open PRs through the signed-in GitHub account when no App integration exists", async () => {
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sealed-account-token");
      if (url.startsWith("https://api.github.com/user/repos?")) {
        return githubResponse(200, [{ full_name: "acme/widgets" }]);
      }
      if (url === "https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=50") {
        return githubResponse(200, [{
          number: 7,
          title: "Fix account review access",
          user: { login: "octocat" },
          head: { sha: "abc123" },
          updated_at: "2026-07-14T01:00:00.000Z",
          html_url: "https://github.com/acme/widgets/pull/7",
        }]);
      }
      return githubResponse(404, {});
    });
    vi.stubGlobal("fetch", githubFetch);

    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/prs`), headers);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      prs: [{
        repo: "acme/widgets",
        number: 7,
        title: "Fix account review access",
        availability: {
          accountConnected: true,
          repositoryAccessible: true,
          autoReviewEnabled: false,
        },
      }],
      canRun: true,
    });
    expect(JSON.stringify(response.body)).not.toContain("sealed-account-token");
  });

  it("keeps a manual account-authorized review run credential-safe", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/acme/widgets");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sealed-account-token");
      return githubResponse(200, { id: 1 });
    }));

    const response = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "security",
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ jobs: [{ id: "review-job-1", lens: "security" }] });
    expect(mocks.enqueueMemoryJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: "pr-security-review",
      input: expect.objectContaining({
        repo: "acme/widgets",
        credentialSource: "github_account",
        installationId: "",
      }),
    }));
    expect(JSON.stringify(mocks.enqueueMemoryJob.mock.calls[0])).not.toContain("sealed-account-token");
    expect(JSON.stringify(response.body)).not.toContain("sealed-account-token");
  });

  it("builds deep-review authority from the authenticated manual request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => githubResponse(200, { id: 1 })));

    const response = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "security",
      mode: "deep",
      deepReview: {
        telemetryThresholds: {
          maxRepositoryFiles: 20_000,
          minIndexedFileRatio: 0.8,
          maxEstimatedModelCalls: 20,
          maxEstimatedToolCalls: 50,
          maxEstimatedDurationMs: 20 * 60_000,
          maxEstimatedUsd: 8,
          acceptedBy: "attacker",
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
      },
    });

    expect(response.status).toBe(202);
    const queued = mocks.enqueueMemoryJob.mock.calls[0]?.[0];
    expect(queued).toMatchObject({
      kind: "pr-security-review",
      maxAttempts: 1,
      input: {
        orgId: "org-1",
        repo: "acme/widgets",
        requestedBy: "user-1",
        reviewMode: "deep",
        requestSource: "manual_api",
        deepReviewPolicy: {
          organizationId: "org-1",
          repository: { forge: "github", slug: "acme/widgets" },
          program: "security_review",
          activation: {
            mode: "explicit_manual",
            requestedBy: "user-1",
            automaticEscalation: false,
          },
          telemetryThresholds: {
            program: "security_review",
            acceptedBy: "user-1",
          },
          coverage: { label: "bounded_whole_repository" },
        },
      },
    });
    expect(JSON.stringify(queued)).not.toContain("attacker");
    expect(JSON.stringify(queued)).not.toContain("sealed-account-token");
  });

  it("does not infer deep review from limits or allow it to replace pentest authority", async () => {
    const limits = {
      telemetryThresholds: {},
      packetLimits: {},
      budgets: {},
    };
    const implicit = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "security",
      deepReview: limits,
    });
    const pentest = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "pentest",
      mode: "deep",
      deepReview: limits,
    });

    expect(implicit.status).toBe(400);
    expect(pentest.status).toBe(400);
    expect(mocks.enqueueMemoryJob).not.toHaveBeenCalled();
  });

  it("rejects a PR pentest without a persisted matching target", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => githubResponse(200, { id: 1 })));

    const response = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "pentest",
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/authorized repository target/);
    expect(mocks.enqueueMemoryJob).not.toHaveBeenCalled();
  });

  it("persists a bounded policy snapshot for an authorized PR pentest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => githubResponse(200, { id: 1 })));
    mocks.getPentestTarget.mockResolvedValue({
      id: "target-1",
      orgId: "org-1",
      createdBy: "user-1",
      kind: "repository",
      value: "acme/widgets",
      normalizedValue: "acme/widgets",
      label: null,
      authorizedAt: "2026-07-29T00:00:00.000Z",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    });

    const response = await postJson(new URL(`${baseUrl}/api/admin/reviews/run`), headers, {
      repo: "acme/widgets",
      prNumber: 7,
      lens: "pentest",
      targetId: "target-1",
    });

    expect(response.status).toBe(202);
    expect(mocks.enqueueMemoryJob).toHaveBeenCalledWith(expect.objectContaining({
      kind: "pr-pentest",
      input: expect.objectContaining({
        assessmentPolicy: expect.objectContaining({
          schemaVersion: 1,
          program: "authorized_pentest",
          target: expect.objectContaining({
            targetId: "target-1",
            normalizedValue: "acme/widgets",
          }),
          perimeter: {
            liveNetwork: false,
            allowedOrigins: [],
            allowedRepositories: ["acme/widgets"],
          },
        }),
      }),
    }));
  });

  it("loads App-accessible PR detail even when the repo is not enrolled for automatic review", async () => {
    mocks.resolveGithubAccountToken.mockResolvedValue(null);
    mocks.getResolvedIntegration.mockResolvedValue({
      id: "integration-1",
      orgId: "org-1",
      source: "github_app",
      config: {
        appId: "123",
        installationId: "456",
        linkedRepositories: [],
      },
      secret: { privateKey: "private-key" },
    });
    mocks.mintInstallationToken.mockResolvedValue({ token: "installation-token" });

    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
      if (url === "https://api.github.com/repos/acme/widgets") return githubResponse(200, { id: 1 });
      if (url === "https://api.github.com/repos/acme/widgets/pulls/7") {
        return githubResponse(200, {
          number: 7,
          title: "Manual-only review",
          user: { login: "octocat" },
          head: { ref: "manual", sha: null },
          html_url: "https://github.com/acme/widgets/pull/7",
        });
      }
      return githubResponse(404, {});
    });
    vi.stubGlobal("fetch", githubFetch);

    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/prs/acme/widgets/7`), headers);

    expect(response.status).toBe(200);
    expect(response.body.pr).toMatchObject({
      repo: "acme/widgets",
      number: 7,
      title: "Manual-only review",
      availability: {
        accountConnected: false,
        repositoryAccessible: true,
        autoReviewEnabled: false,
      },
    });
  });

  it("lists App-accessible PRs independently of automatic-review enrollment", async () => {
    mocks.resolveGithubAccountToken.mockResolvedValue(null);
    mocks.getResolvedIntegration.mockResolvedValue({
      id: "integration-1",
      orgId: "org-app",
      source: "github_app",
      config: {
        appId: "123",
        installationId: "456",
        linkedRepositories: [],
      },
      secret: { privateKey: "private-key" },
    });
    mocks.mintInstallationToken.mockResolvedValue({ token: "installation-token" });

    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
      if (url === "https://api.github.com/installation/repositories?per_page=100") {
        return githubResponse(200, { repositories: [{ full_name: "acme/widgets" }] });
      }
      if (url === "https://api.github.com/repos/acme/widgets/pulls?state=open&per_page=50") {
        return githubResponse(200, [{
          number: 8,
          title: "Visible without auto review",
          user: { login: "octocat" },
          head: { sha: "def456" },
          updated_at: "2026-07-14T02:00:00.000Z",
          html_url: "https://github.com/acme/widgets/pull/8",
        }]);
      }
      return githubResponse(404, {});
    }));

    const response = await getJson(new URL(`${baseUrl}/api/admin/reviews/prs`), {
      ...headers,
      "X-BrainRouter-Org": "org-app",
    });

    expect(response.status).toBe(200);
    expect(response.body.prs).toEqual([expect.objectContaining({
      repo: "acme/widgets",
      number: 8,
      title: "Visible without auto review",
      availability: {
        accountConnected: false,
        repositoryAccessible: true,
        autoReviewEnabled: false,
      },
    })]);
  });
});
