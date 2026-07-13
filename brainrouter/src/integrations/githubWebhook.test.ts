import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { verifyGithubSignature, processGithubDelivery, isRepoLinkedForReview, isRepoAvailableForManualReview, parseReviewCommand, resolveCommenterPermission, resolveReviewPolicy, type WebhookDeps } from "./githubWebhook.js";

const SECRET = "whsec_test_123";
function sign(raw: Buffer, secret = SECRET): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}

describe("ADR-010 P6b — GitHub webhook core", () => {
  it("verifyGithubSignature: accepts a valid HMAC, rejects wrong/empty", () => {
    const raw = Buffer.from(JSON.stringify({ hello: "world" }));
    expect(verifyGithubSignature(SECRET, raw, sign(raw))).toBe(true);
    expect(verifyGithubSignature(SECRET, raw, sign(raw, "other"))).toBe(false);
    expect(verifyGithubSignature(SECRET, raw, undefined)).toBe(false);
    expect(verifyGithubSignature("", raw, sign(raw))).toBe(false);
    expect(verifyGithubSignature(SECRET, Buffer.alloc(0), sign(Buffer.alloc(0)))).toBe(false);
  });

  const integ = {
    orgId: "org_acme",
    kind: "github_app" as const,
    config: { installationId: "42" },
    secret: { webhookSecret: SECRET },
  };
  const deps = (over: Partial<WebhookDeps> = {}): WebhookDeps => ({
    findIntegrationByInstallation: async (id) => (id === "42" ? integ : null),
    enqueue: vi.fn(async () => undefined),
    ...over,
  });

  it("no installation id → generic 202 (no enqueue)", async () => {
    const d = deps();
    const out = await processGithubDelivery(d, { body: {}, rawBody: Buffer.alloc(0) });
    expect(out.status).toBe(202);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("unknown installation → generic 202 (no leak, no enqueue)", async () => {
    const d = deps();
    const out = await processGithubDelivery(d, { body: { installation: { id: 999 } }, rawBody: Buffer.from("{}") });
    expect(out.status).toBe(202);
    expect(out.body.skipped).toBe("unknown-installation");
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("known installation, BAD signature → 401 (no enqueue)", async () => {
    const d = deps();
    const raw = Buffer.from(JSON.stringify({ installation: { id: 42 } }));
    const out = await processGithubDelivery(d, { body: JSON.parse(raw.toString()), rawBody: raw, signature: "sha256=deadbeef" });
    expect(out.status).toBe(401);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("known installation, VALID signature → 202 + tenant-tagged enqueue", async () => {
    const d = deps();
    const payload = { installation: { id: 42 }, action: "opened", repository: { full_name: "acme/app" }, issue: { number: 7 } };
    const raw = Buffer.from(JSON.stringify(payload));
    const out = await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "issues", delivery: "d-1" });
    expect(out.status).toBe(202);
    expect(out.body.orgId).toBe("org_acme");
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    const job = (d.enqueue as any).mock.calls[0][0];
    expect(job.kind).toBe("trigger.github");
    expect(job.input.orgId).toBe("org_acme");
    expect(job.input.repo).toBe("acme/app");
    expect(job.input.number).toBe(7);
  });

  it("pull_request opened → enqueues security only when code review defaults to manual", async () => {
    const d = deps();
    const payload = { installation: { id: 42 }, action: "opened", repository: { full_name: "acme/app" }, pull_request: { number: 12, head: { sha: "abc123" } } };
    const raw = Buffer.from(JSON.stringify(payload));
    const out = await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "pull_request", delivery: "d-2" });
    expect(out.status).toBe(202);
    const kinds = (d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toContain("pr-security-review");
    expect(kinds).not.toContain("pr-code-review");
    const review = (d.enqueue as any).mock.calls.find((c: any[]) => c[0].kind === "pr-security-review")[0];
    expect(review.input.repo).toBe("acme/app");
    expect(review.input.prNumber).toBe(12);
    expect(review.input.headSha).toBe("abc123");
    expect(review.input.installationId).toBe("42");
  });

  it("isRepoLinkedForReview: absent field → all; present allowlist → membership", () => {
    expect(isRepoLinkedForReview({ installationId: "42" }, "acme/app")).toBe(true); // never configured → review all
    expect(isRepoLinkedForReview({ linkedRepositories: ["acme/app", "acme/lib"] }, "acme/app")).toBe(true);
    expect(isRepoLinkedForReview({ linkedRepositories: ["Acme/App"] }, "acme/app")).toBe(true); // GitHub names are case-insensitive
    expect(isRepoLinkedForReview({ linkedRepositories: ["acme/other"] }, "acme/app")).toBe(false);
    expect(isRepoLinkedForReview({ linkedRepositories: [] }, "acme/app")).toBe(false); // opted in to nothing
    expect(isRepoLinkedForReview(undefined, "acme/app")).toBe(true);
  });

  it("manual review accepts repositories available to the connected GitHub App", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ full_name: "acme/app" }), { status: 200 })) as unknown as typeof fetch;

    await expect(isRepoAvailableForManualReview(
      { linkedRepositories: [] },
      "acme/app",
      { apiBase: "https://api.github.com", token: "installation-token" },
      fetchImpl,
    )).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/app",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer installation-token" }) }),
    );
  });

  it("manual review remains denied when the GitHub App cannot access the repository", async () => {
    const deniedFetch = vi.fn(async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const failingFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    await expect(isRepoAvailableForManualReview(
      { linkedRepositories: ["acme/other"] },
      "acme/app",
      { apiBase: "https://api.github.com", token: "installation-token" },
      deniedFetch,
    )).resolves.toBe(false);
    await expect(isRepoAvailableForManualReview(
      { linkedRepositories: [] },
      "acme/app",
      { apiBase: "https://api.github.com", token: "installation-token" },
      failingFetch,
    )).resolves.toBe(false);
  });

  it("pull_request on an UNLINKED repo → trigger enqueues but NO reviews", async () => {
    const gatedInteg = { ...integ, config: { installationId: "42", linkedRepositories: ["acme/other"] } };
    const d = deps({ findIntegrationByInstallation: async (id) => (id === "42" ? gatedInteg : null) });
    const payload = { installation: { id: 42 }, action: "opened", repository: { full_name: "acme/app" }, pull_request: { number: 12, head: { sha: "abc123" } } };
    const raw = Buffer.from(JSON.stringify(payload));
    await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "pull_request", delivery: "d-3" });
    const kinds = (d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toContain("trigger.github"); // triggers still fire
    expect(kinds).not.toContain("pr-security-review"); // but the repo isn't linked → no review
    expect(kinds).not.toContain("pr-code-review");
  });

  it("commands select a lens and the allowlist permits a dashboard-configured runner", async () => {
    const allowed = { ...integ, config: { installationId: "42", manualReviewRunners: { allowlist: ["maintainer"] } } };
    const d = deps({ findIntegrationByInstallation: async (id) => (id === "42" ? allowed : null) });
    const payload = { installation: { id: 42 }, action: "created", repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: { url: "x" } }, comment: { body: "please /code-review this", user: { login: "maintainer", type: "User" } } };
    const raw = Buffer.from(JSON.stringify(payload));
    await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "issue_comment", delivery: "d-4" });
    const kinds = (d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toContain("pr-code-review");
    const rerun = (d.enqueue as any).mock.calls.find((c: any[]) => c[0].kind === "pr-code-review")[0];
    expect(rerun.input.prNumber).toBe(12);
    expect(rerun.input.headSha).toBe(""); // resolved later by the executor
  });

  it("ignores bot commenters and denies users without configured permission/allowlist", async () => {
    const makePayload = (user: { login: string; type: string }) => ({ installation: { id: 42 }, action: "created", repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: { url: "x" } }, comment: { body: "/security-review", user } });
    const human = makePayload({ login: "reader", type: "User" });
    const humanRaw = Buffer.from(JSON.stringify(human));
    const denied = deps();
    await processGithubDelivery(denied, { body: human, rawBody: humanRaw, signature: sign(humanRaw), event: "issue_comment" });
    expect((denied.enqueue as any).mock.calls.map((c: any[]) => c[0].kind)).not.toContain("pr-security-review");
    const bot = makePayload({ login: "dependabot[bot]", type: "Bot" });
    const botRaw = Buffer.from(JSON.stringify(bot));
    const ignored = deps();
    await processGithubDelivery(ignored, { body: bot, rawBody: botRaw, signature: sign(botRaw), event: "issue_comment" });
    expect((ignored.enqueue as any).mock.calls.map((c: any[]) => c[0].kind)).not.toContain("pr-security-review");
  });

  it("parser separates /security-review, /code-review and legacy /review", () => {
    expect(parseReviewCommand("/security-review")).toBe("security");
    expect(parseReviewCommand("@brainrouter code-review please")).toBe("code");
    expect(parseReviewCommand("/review")).toBe("both");
    expect(parseReviewCommand("/code-review")).not.toBe("both");
    expect(parseReviewCommand("/review-later")).toBeNull();
  });

  it("resolveCommenterPermission treats unavailable or unknown permissions as none", async () => {
    const ok = await resolveCommenterPermission((async () => ({ ok: true, json: async () => ({ permission: "maintain" }) })) as any, "https://api.github.com", "a/b", "u", "t");
    const denied = await resolveCommenterPermission((async () => ({ ok: false, json: async () => ({}) })) as any, "https://api.github.com", "a/b", "u", "t");
    expect(ok).toBe("maintain");
    expect(denied).toBe("none");
  });

  it("resolveReviewPolicy: per-repo override beats org default beats built-in", () => {
    expect(resolveReviewPolicy(undefined, "a/b")).toEqual({ approveClean: false, blockOnFindings: true, reReviewOnPush: true, codeReviewTrigger: "manual" });
    expect(resolveReviewPolicy({ reviewPolicyDefaults: { blockOnFindings: false } }, "a/b").blockOnFindings).toBe(false);
    expect(resolveReviewPolicy({ reviewPolicyDefaults: { blockOnFindings: false }, reviewPolicies: { "a/b": { blockOnFindings: true } } }, "a/b").blockOnFindings).toBe(true);
    expect(resolveReviewPolicy({ reviewPolicies: { "a/b": { approveClean: true } } }, "a/b").approveClean).toBe(true);
  });

  it("code review joins auto events only when codeReviewTrigger is auto", async () => {
    const auto = { ...integ, config: { installationId: "42", reviewPolicyDefaults: { codeReviewTrigger: "auto" } } };
    const d = deps({ findIntegrationByInstallation: async (id) => (id === "42" ? auto : null) });
    const payload = { installation: { id: 42 }, action: "opened", repository: { full_name: "acme/app" }, pull_request: { number: 12, head: { sha: "s" } } };
    const raw = Buffer.from(JSON.stringify(payload));
    await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "pull_request" });
    expect((d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind)).toContain("pr-code-review");
  });

  it("synchronize with reReviewOnPush OFF → no re-review; but `opened` still reviews", async () => {
    const noRe = { ...integ, config: { installationId: "42", reviewPolicyDefaults: { reReviewOnPush: false } } };
    const mk = () => deps({ findIntegrationByInstallation: async (id) => (id === "42" ? noRe : null) });
    const base = { installation: { id: 42 }, repository: { full_name: "acme/app" }, pull_request: { number: 12, head: { sha: "s" } } };
    const d1 = mk();
    const raw1 = Buffer.from(JSON.stringify({ ...base, action: "synchronize" }));
    await processGithubDelivery(d1, { body: { ...base, action: "synchronize" }, rawBody: raw1, signature: sign(raw1), event: "pull_request", delivery: "d-6" });
    // reReviewOnPush OFF on a synchronize skips the automatic security review.
    const d1Kinds = (d1.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(d1Kinds).not.toContain("pr-security-review");
    expect(d1Kinds).not.toContain("pr-code-review");
    const d2 = mk();
    const raw2 = Buffer.from(JSON.stringify({ ...base, action: "opened" }));
    await processGithubDelivery(d2, { body: { ...base, action: "opened" }, rawBody: raw2, signature: sign(raw2), event: "pull_request", delivery: "d-7" });
    expect((d2.enqueue as any).mock.calls.map((c: any[]) => c[0].kind)).toContain("pr-security-review");
  });

  it("a non-review comment does NOT trigger a review", async () => {
    const d = deps();
    const payload = { installation: { id: 42 }, action: "created", repository: { full_name: "acme/app" }, issue: { number: 12, pull_request: { url: "x" } }, comment: { body: "nice work, lgtm" } };
    const raw = Buffer.from(JSON.stringify(payload));
    await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "issue_comment", delivery: "d-5" });
    const kinds = (d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).not.toContain("pr-security-review");
  });
});
