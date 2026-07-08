import { describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { verifyGithubSignature, processGithubDelivery, type WebhookDeps } from "./githubWebhook.js";

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

  it("pull_request opened → also enqueues a pr-security-review job (ADR-017 D5)", async () => {
    const d = deps();
    const payload = { installation: { id: 42 }, action: "opened", repository: { full_name: "acme/app" }, pull_request: { number: 12, head: { sha: "abc123" } } };
    const raw = Buffer.from(JSON.stringify(payload));
    const out = await processGithubDelivery(d, { body: payload, rawBody: raw, signature: sign(raw), event: "pull_request", delivery: "d-2" });
    expect(out.status).toBe(202);
    const kinds = (d.enqueue as any).mock.calls.map((c: any[]) => c[0].kind);
    expect(kinds).toContain("pr-security-review");
    const review = (d.enqueue as any).mock.calls.find((c: any[]) => c[0].kind === "pr-security-review")[0];
    expect(review.input.repo).toBe("acme/app");
    expect(review.input.prNumber).toBe(12);
    expect(review.input.headSha).toBe("abc123");
    expect(review.input.installationId).toBe("42");
  });
});
