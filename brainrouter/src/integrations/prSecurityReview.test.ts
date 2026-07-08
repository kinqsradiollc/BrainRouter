import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { runPrSecurityReview, runPrCodeReview, type PrSecurityReviewDeps } from "./prSecurityReview.js";
import type { LLMRunner } from "@kinqs/brainrouter-types";

// A real RSA key so buildAppJwt (RS256) actually signs during token mint.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const REVIEW_OUT = 'Findings.\n```json\n[{"file":"x.ts","line":1,"severity":"high","summary":"[CWE-89] SQL injection","confidence":90}]\n```';
const llm = (out: string): LLMRunner => ({ run: async () => out });

// A realistic added-file diff so `addedLinesByPath` yields commentable RIGHT-side lines.
const DIFF_ADDED = [
  "diff --git a/x.ts b/x.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/x.ts",
  "@@ -0,0 +1,3 @@",
  "+import x;",
  "+const q = `SELECT * FROM u WHERE id=${req.query.id}`;",
  "+db.query(q);",
  "",
].join("\n");

// A finding anchored to line 2 of the added file, carrying an exact `replacement`.
const REVIEW_INLINE =
  '```json\n[{"file":"x.ts","line":2,"endLine":2,"severity":"high","confidence":95,' +
  '"summary":"[CWE-89] SQL injection","details":"req.query.id flows into the query.",' +
  '"suggestion":"parameterize","replacement":"const q = \'SELECT * FROM u WHERE id=?\';"}]\n```';

interface Routes {
  calls: string[];
  comments?: unknown[];
  inlineComments?: unknown[];
  diff?: string;
  reviewOk?: boolean; // grouped-review POST result (default true)
  checksOk?: boolean; // check-run POST result (default true; false simulates missing `checks: write`)
  bodies?: Record<string, string>; // captured request bodies by "METHOD path"
}

const CODE_INLINE =
  '```json\n[{"file":"x.ts","line":2,"endLine":2,"severity":"high","confidence":90,' +
  '"summary":"Off-by-one in the loop bound","details":"iterates one past the end.",' +
  '"suggestion":"use < not <=","replacement":"for (let i = 0; i < n; i++) {"}]\n```';

function mockFetch(routes: Routes) {
  return (async (url: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.replace("https://api.github.com", "");
    routes.calls.push(`${method} ${path}`);
    if (init?.body) { routes.bodies ??= {}; routes.bodies[`${method} ${path}`] = init.body; }
    if (url.includes("/access_tokens") && method === "POST") return { ok: true, status: 201, json: async () => ({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }) };
    if (/\/pulls\/\d+$/.test(url)) return { ok: true, status: 200, text: async () => routes.diff ?? "diff --git a/x b/x\n+const q = `SELECT * FROM u WHERE id=${id}`;\n", json: async () => ({ head: { sha: "resolvedsha" } }) };
    if (/\/pulls\/\d+\/comments/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => routes.inlineComments ?? [] };
    if (/\/pulls\/\d+\/comments$/.test(url) && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 321 }) };
    if (/\/pulls\/\d+\/reviews$/.test(url) && method === "POST") return { ok: routes.reviewOk ?? true, status: (routes.reviewOk ?? true) ? 200 : 422, json: async () => ({ id: 77 }) };
    if (/\/check-runs$/.test(url) && method === "POST") return { ok: routes.checksOk ?? true, status: (routes.checksOk ?? true) ? 201 : 403, json: async () => ({ id: 88 }) };
    if (/\/issues\/\d+\/comments/.test(url) && method === "GET") return { ok: true, status: 200, json: async () => routes.comments ?? [] };
    if (/\/issues\/\d+\/comments$/.test(url) && method === "POST") return { ok: true, status: 201, json: async () => ({ id: 999 }) };
    if (/\/issues\/comments\/\d+$/.test(url) && method === "PATCH") return { ok: true, status: 200, json: async () => ({ id: 1 }) };
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function makeDeps(routes: Routes, over: Partial<PrSecurityReviewDeps> = {}): PrSecurityReviewDeps {
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
    const routes: Routes = { calls: [] };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "abcdef1234" }, makeDeps(routes));
    expect(r.ok).toBe(true);
    expect(r.findings).toBe(1);
    expect(r.posted).toBe(true);
    expect(routes.calls.some((c) => c === "POST /app/installations/42/access_tokens")).toBe(true);
    expect(routes.calls.some((c) => c.includes("POST /repos/o/r/issues/7/comments"))).toBe(true);
  });

  it("updates its existing comment in place (idempotent by marker)", async () => {
    const routes: Routes = { calls: [], comments: [{ id: 55, body: "<!-- brainrouter-security-review -->\nold review" }] };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "x" }, makeDeps(routes));
    expect(r.posted).toBe(true);
    expect(routes.calls.some((c) => c === "PATCH /repos/o/r/issues/comments/55")).toBe(true);
    expect(routes.calls.some((c) => c.includes("POST /repos/o/r/issues"))).toBe(false);
  });

  it("posts a grouped PR review with an inline ```suggestion anchored to the diff", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "deadbeef" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.reviewPosted).toBe(true);
    expect(r.inlinePosted).toBe(1);
    expect(routes.calls.some((c) => c === "POST /repos/o/r/pulls/7/reviews")).toBe(true);
    const reviewBody = routes.bodies?.["POST /repos/o/r/pulls/7/reviews"] ?? "";
    expect(reviewBody).toContain("```suggestion");
    expect(reviewBody).toContain("SELECT * FROM u WHERE id=?");
    expect(reviewBody).toContain('"commit_id":"deadbeef"');
    expect(reviewBody).toContain('"event":"COMMENT"');
  });

  it("posts a gating check-run — a blocking finding ⇒ failure conclusion", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "deadbeef" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.checkPosted).toBe(true);
    expect(r.blocking).toBe(1);
    const cb = routes.bodies?.["POST /repos/o/r/check-runs"] ?? "";
    expect(cb).toContain('"conclusion":"failure"');
    expect(cb).toContain('"name":"BrainRouter security review"');
    expect(cb).toContain('"head_sha":"deadbeef"');
  });

  it("check-run is neutral, not blocking, for a low-severity finding", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const lowFinding = '```json\n[{"file":"x.ts","line":2,"endLine":2,"severity":"low","confidence":60,"summary":"minor","details":"d","replacement":"const q = 1;"}]\n```';
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, makeDeps(routes, { llmRunner: llm(lowFinding) }));
    expect(r.blocking).toBe(0);
    expect(routes.bodies?.["POST /repos/o/r/check-runs"] ?? "").toContain('"conclusion":"neutral"');
  });

  it("degrades gracefully when the App lacks `checks: write` (check-run 403)", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED, checksOk: false };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.checkPosted).toBe(false); // no permission → no gate, but the review still posted
    expect(r.reviewPosted).toBe(true);
    expect(r.posted).toBe(true);
  });

  it("code-review lens posts under its OWN marker + check name (distinct from security)", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const r = await runPrCodeReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, makeDeps(routes, { llmRunner: llm(CODE_INLINE) }));
    expect(r.reviewPosted).toBe(true);
    const reviewBody = routes.bodies?.["POST /repos/o/r/pulls/7/reviews"] ?? "";
    expect(reviewBody).toContain("brc-finding:"); // code-review inline marker prefix, not brs
    expect(reviewBody).toContain("🔎 BrainRouter code review");
    expect(routes.bodies?.["POST /repos/o/r/check-runs"] ?? "").toContain('"name":"BrainRouter code review"');
    const summary = routes.bodies?.["POST /repos/o/r/issues/7/comments"] ?? "";
    expect(summary).toContain("<!-- brainrouter-code-review -->");
  });

  it("does not re-post an inline finding it already surfaced (dedup by marker)", async () => {
    const routes: Routes = {
      calls: [], diff: DIFF_ADDED,
      inlineComments: [{ body: "<!-- brs-finding:x-ts-cwe-89-sql-injection -->\nalready posted" }],
    };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "x" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.inlinePosted).toBe(0);
    expect(r.reviewPosted).toBe(false);
    expect(routes.calls.some((c) => c === "POST /repos/o/r/pulls/7/reviews")).toBe(false);
    expect(r.posted).toBe(true); // pinned summary still updated
  });

  it("falls back to individual inline comments when the grouped review 422s", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED, reviewOk: false };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "x" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.reviewPosted).toBe(false);
    expect(r.inlinePosted).toBe(1);
    expect(routes.calls.some((c) => c === "POST /repos/o/r/pulls/7/comments")).toBe(true);
  });

  it("resolves the head SHA from the PR when a comment re-run omits it", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    expect(r.checkPosted).toBe(true);
    expect(routes.bodies?.["POST /repos/o/r/check-runs"] ?? "").toContain('"head_sha":"resolvedsha"');
  });

  it("summary comment carries the Re-run / Manage affordances", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, makeDeps(routes, { llmRunner: llm(REVIEW_INLINE) }));
    const summary = routes.bodies?.["POST /repos/o/r/issues/7/comments"] ?? "";
    expect(summary).toContain("Re-run:");
    expect(summary).toContain("/review");
  });

  it("blockOnFindings OFF ⇒ check-run is advisory (neutral), not failure, despite blocking", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const d = makeDeps(routes, { llmRunner: llm(REVIEW_INLINE), getIntegration: async () => ({ config: { appId: "4237068", reviewPolicyDefaults: { blockOnFindings: false } }, secret: { privateKey } }) });
    await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, d);
    expect(routes.bodies?.["POST /repos/o/r/check-runs"] ?? "").toContain('"conclusion":"neutral"');
  });

  it("approveClean ON + a clean lens ⇒ posts an APPROVE review", async () => {
    const routes: Routes = { calls: [], diff: DIFF_ADDED };
    const d = makeDeps(routes, { llmRunner: llm("```json\n[]\n```"), getIntegration: async () => ({ config: { appId: "4237068", reviewPolicyDefaults: { approveClean: true } }, secret: { privateKey } }) });
    const r = await runPrSecurityReview({ installationId: "42", repo: "o/r", prNumber: 7, headSha: "sha" }, d);
    expect(r.approved).toBe(true);
    expect(routes.bodies?.["POST /repos/o/r/pulls/7/reviews"] ?? "").toContain('"event":"APPROVE"');
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
