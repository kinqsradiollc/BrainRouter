/**
 * ADR-033 D9 — what the review is allowed to read, and what it is told when
 * the answer is no.
 */
import { describe, expect, it, vi } from "vitest";
import { createReviewFileAccess } from "./reviewFileAccess.js";

function reader(files: Record<string, string>) {
  return {
    readSourceFile: vi.fn(async (path: string, maxBytes: number) => {
      const content = files[path];
      if (content === undefined) throw new Error(`/tmp/brainrouter-assurance/checkout-abc/source/${path}: ENOENT`);
      if (content.length > maxBytes) throw new Error("Requested source path exceeds the read limit.");
      return content;
    }),
  };
}

describe("review file access", () => {
  it("serves an inventoried file and refuses everything that climbs out", async () => {
    const source = reader({ "src/a.ts": "export const a = 1;" });
    const access = createReviewFileAccess(source);
    const answers = await access.serve([
      "src/a.ts",
      "../../../etc/passwd",
      "/etc/passwd",
      "src\\a.ts",
      "src/./../../secrets.env",
    ], "bundle-a");
    expect(answers[0]).toEqual({ path: "src/a.ts", content: "export const a = 1;" });
    for (const refused of answers.slice(1)) {
      expect(refused.content).toBeUndefined();
      expect(refused.unavailableReason).toMatch(/repo-relative path inside the reviewed checkout/);
    }
    // Only the legitimate path ever reached the checkout adapter.
    expect(source.readSourceFile).toHaveBeenCalledTimes(1);
    expect(access.filesServed).toBe(1);
  });

  it("never leaks the filesystem when a path is not in the checkout", async () => {
    const access = createReviewFileAccess(reader({}));
    const [answer] = await access.serve(["src/missing.ts"], "bundle-a");
    expect(answer.unavailableReason).toBe("not part of the reviewed checkout at this exact revision");
    expect(answer.unavailableReason).not.toMatch(/tmp|ENOENT/);
  });

  it("stops serving once the budget is spent, and says so", async () => {
    const access = createReviewFileAccess(reader({ "a.ts": "a", "b.ts": "b", "c.ts": "c" }), { maxFiles: 2 });
    const answers = await access.serve(["a.ts", "b.ts", "c.ts"], "bundle-a");
    expect(answers.map((answer) => answer.content)).toEqual(["a", "b", undefined]);
    expect(answers[2].unavailableReason).toMatch(/budget is spent/);
  });

  it("truncates a served file to the byte budget instead of blowing the context", async () => {
    const access = createReviewFileAccess(reader({ "big.ts": "x".repeat(10_000) }), {
      maxBytesPerFile: 1_024,
      maxTotalBytes: 2_048,
    });
    const [answer] = await access.serve(["big.ts"], "bundle-a");
    // The adapter refuses an oversized read outright; the reviewer is told the
    // file is unavailable rather than being handed a silent partial file.
    expect(answer.content ?? answer.unavailableReason).toBeTruthy();
    expect(answer.content?.length ?? 0).toBeLessThanOrEqual(1_100);
  });

  it("tells a too-large file apart from a missing one", async () => {
    // Collapsing both into "not part of the reviewed checkout" told the reviewer
    // a file that EXISTS does not — the exact confusion this module's header
    // says it exists to prevent, and it lands on the big files a reviewer most
    // wants to see.
    const access = createReviewFileAccess(reader({ "big.ts": "x".repeat(10_000), "small.ts": "ok" }), {
      maxBytesPerFile: 1_024,
      maxTotalBytes: 8_192,
    });
    const [big, missing] = await access.serve(["big.ts", "gone.ts"], "bundle-a");
    expect(big.content).toBeUndefined();
    expect(big.unavailableReason).toBe(
      "present in the reviewed checkout, but larger than one request may return",
    );
    expect(missing.unavailableReason).toBe("not part of the reviewed checkout at this exact revision");
    // Neither answer may carry the filesystem.
    expect(`${big.unavailableReason} ${missing.unavailableReason}`).not.toMatch(/tmp|ENOENT/);
  });

  it("labels repeated paths instead of silently dropping them", async () => {
    const source = reader({ "a.ts": "a" });
    const access = createReviewFileAccess(source);
    const answers = await access.serve(["a.ts", "a.ts", "./a.ts"], "bundle-a");
    expect(answers).toHaveLength(3);
    expect(answers[0].content).toBe("a");
    expect(answers.slice(1).every((answer) => answer.unavailableReason?.includes("already answered"))).toBe(true);
    expect(source.readSourceFile).toHaveBeenCalledTimes(1);
  });

  it("redacts secrets and refuses credential-bearing paths before the checkout read", async () => {
    const source = reader({
      "src/config.ts": "const token = 'sk-abcdefghijklmnop';",
      ".env": "API_KEY=super-secret-value",
    });
    const access = createReviewFileAccess(source);
    const [sourceFile, environment] = await access.serve(
      ["src/config.ts", ".env"],
      "bundle-a",
    );
    expect(sourceFile.content).toContain("[REDACTED]");
    expect(sourceFile.content).not.toContain("sk-abcdefghijklmnop");
    expect(environment.content).toBeUndefined();
    expect(environment.unavailableReason).toMatch(/review source policy/);
    expect(source.readSourceFile).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent bundles against one shared budget and labels every answer", async () => {
    const source = reader({ "a.ts": "a", "b.ts": "b" });
    const access = createReviewFileAccess(source, { maxFiles: 1, maxRequests: 2 });
    const [first, second] = await Promise.all([
      access.serve(["a.ts"], "bundle-a"),
      access.serve(["b.ts"], "bundle-b"),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect([first[0].content, second[0].content].filter(Boolean)).toHaveLength(1);
    expect([first[0].unavailableReason, second[0].unavailableReason].filter(Boolean)).toEqual([
      "the review's file-request budget is spent",
    ]);
    expect(access.filesServed).toBe(1);
  });

  it("labels concurrent repeats inside one bundle without racing the checkout", async () => {
    const source = reader({ "a.ts": "a" });
    const access = createReviewFileAccess(source);
    const [first, repeated] = await Promise.all([
      access.serve(["a.ts"], "bundle-a"),
      access.serve(["a.ts"], "bundle-a"),
    ]);
    expect(first[0].content).toBe("a");
    expect(repeated[0].unavailableReason).toContain("already answered");
    expect(source.readSourceFile).toHaveBeenCalledTimes(1);
  });

  it("bounds failed lookup attempts as well as successful file reads", async () => {
    const source = reader({});
    const access = createReviewFileAccess(source, { maxRequests: 2 });
    const answers = await access.serve(["missing-a.ts", "missing-b.ts", "missing-c.ts"], "bundle-a");
    expect(answers.slice(0, 2).every((answer) => answer.unavailableReason?.includes("not part"))).toBe(true);
    expect(answers[2].unavailableReason).toContain("budget is spent");
    expect(source.readSourceFile).toHaveBeenCalledTimes(2);
  });

  it("serves the same safe path independently to two isolated bundles", async () => {
    const source = reader({ "shared.ts": "export const shared = true;" });
    const access = createReviewFileAccess(source, { maxFiles: 2 });
    const [first, second] = await Promise.all([
      access.serve(["shared.ts"], "bundle-a"),
      access.serve(["shared.ts"], "bundle-b"),
    ]);
    expect(first[0].content).toContain("shared");
    expect(second[0].content).toContain("shared");
    expect(source.readSourceFile).toHaveBeenCalledTimes(2);
  });

  it("enforces the total budget in UTF-8 bytes", async () => {
    const access = createReviewFileAccess(reader({ "unicode.ts": `abc${"🔐".repeat(400)}` }), {
      maxBytesPerFile: 2_048,
      maxTotalBytes: 1_024,
    });
    const [answer] = await access.serve(["unicode.ts"], "bundle-a");
    expect(Buffer.byteLength(answer.content ?? "")).toBeLessThanOrEqual(1_024);
    expect(answer.content).not.toContain("�");
  });

  it("reads exact positioning source through an independent safe, cached boundary", async () => {
    const secret = `sk-${"x".repeat(24)}`;
    const source = reader({
      "src/a.ts": `export const token = '${secret}';`,
      ".env": "TOKEN=do-not-read",
      "src/huge.ts": "x".repeat(600 * 1024),
    });
    const access = createReviewFileAccess(source, { maxFiles: 1, maxRequests: 1 });

    const [first, cached, sensitive, outside, oversized] = await Promise.all([
      access.readForPosition("src/a.ts"),
      access.readForPosition("src/a.ts"),
      access.readForPosition(".env"),
      access.readForPosition("../outside.ts"),
      access.readForPosition("src/huge.ts"),
    ]);

    expect(first).toContain("[REDACTED]");
    expect(first).not.toContain(secret);
    expect(cached).toBe(first);
    expect(sensitive).toBeNull();
    expect(outside).toBeNull();
    expect(oversized).toBeNull();
    expect(source.readSourceFile).toHaveBeenCalledTimes(2);
    expect(access.filesServed).toBe(0);
  });
});
