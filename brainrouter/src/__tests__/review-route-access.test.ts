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
