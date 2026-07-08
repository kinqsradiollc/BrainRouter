import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { runPrSecurityReview, type PrSecurityReviewDeps } from "./prSecurityReview.js";
import type { LLMRunner } from "@kinqs/brainrouter-types";

// A real RSA key so buildAppJwt (RS256) actually signs during token mint.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const REVIEW_OUT = 'Findings.\n```json\n[{"file":"x.ts","line":1,"severity":"high","summary":"[CWE-89] SQL injection","confidence":90}]\n```';
const llm = (out: string): LLMRunner => ({ run: async () => out });

function mockFetch(routes: { calls: string[]; comments?: unknown[]; diff?: string }) {
  return (async (url: string, init?: { method?: string }): Promise<unknown> => {
    const method = (init?.method ?? "GET").toUpperCase();
    routes.calls.push(`${method} ${url.replace("https://api.github.com", "")}`);
    if (url.includes("/access_tokens") && method === "POST") return { ok: true, status: 201, json: async () => ({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }) };
    if (/\/pulls\/\d+$/.test(url)) return { ok: true, status: 200, text: async () => routes.diff ?? "diff --git a/x b/x\n+const q = `SELECT * FROM u WHERE id=${id}`;\n" };
    if (/\/issues\/\d+\/comments/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => routes.comments ?? [] };
    if (/\/issues\/\d+\/comments$/.test(url) && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 999 }) };
    if (/\/issues\/comments\/\d+$/.test(url) && method === "PATCH") return { ok: true, status: 200, json: async () => ({ id: 1 }) };
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function makeDeps(routes: { calls: string[]; comments?: unknown[]; diff?: string }, over: Partial<PrSecurityReviewDeps> = {}): PrSecurityReviewDeps {
  return {
    llmRunner: llm(REVIEW_OUT),
    fetchImpl: mockFetch(routes),
    nowSec: () => 1_700_000_000,
    getIntegration: async () => ({ config: { appId: "4237068" }, secret: { privateKey } }),
    ...over,
  };
}

describe("PR security review executor (ADR-017 D5)", () => {
  it("mints a token, reviews the diff, and posts a new comment", async () => {
    const routes = { calls: [] as string[] };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "abcdef1234" }, makeDeps(routes));
    expect(r.ok).toBe(true);
    expect(r.findings).toBe(1);
    expect(r.posted).toBe(true);
    expect(routes.calls.some((c) => c === "POST /app/installations/42/access_tokens")).toBe(true);
    expect(routes.calls.some((c) => c.includes("POST /repos/o/r/issues/7/comments"))).toBe(true);
  });

  it("updates its existing comment in place (idempotent by marker)", async () => {
    const routes = { calls: [] as string[], comments: [{ id: 55, body: "<!-- brainrouter-security-review -->\nold review" }] };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "x" }, makeDeps(routes));
    expect(r.posted).toBe(true);
    expect(routes.calls.some((c) => c === "PATCH /repos/o/r/issues/comments/55")).toBe(true);
    expect(routes.calls.some((c) => c.includes("POST /repos/o/r/issues"))).toBe(false);
  });

  it("skips bad input and a missing integration without throwing", async () => {
    expect((await runPrSecurityReview({ installationId: "42", repo: "bad", prNumber: 1, headSha: "x" }, makeDeps({ calls: [] }))).skipped).toBe("bad-input");
    expect((await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 1, headSha: "x" }, makeDeps({ calls: [] }, { getIntegration: async () => null }))).skipped).toBe("no-integration");
  });

  it("skips when the app creds are incomplete", async () => {
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 1, headSha: "x" }, makeDeps({ calls: [] }, { getIntegration: async () => ({ config: {}, secret: {} }) }));
    expect(r.skipped).toBe("no-app-creds");
  });
});
