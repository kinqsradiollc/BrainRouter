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
    ]);
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
    const [answer] = await access.serve(["src/missing.ts"]);
    expect(answer.unavailableReason).toBe("not part of the reviewed checkout at this exact revision");
    expect(answer.unavailableReason).not.toMatch(/tmp|ENOENT/);
  });

  it("stops serving once the budget is spent, and says so", async () => {
    const access = createReviewFileAccess(reader({ "a.ts": "a", "b.ts": "b", "c.ts": "c" }), { maxFiles: 2 });
    const answers = await access.serve(["a.ts", "b.ts", "c.ts"]);
    expect(answers.map((answer) => answer.content)).toEqual(["a", "b", undefined]);
    expect(answers[2].unavailableReason).toMatch(/budget is spent/);
  });

  it("truncates a served file to the byte budget instead of blowing the context", async () => {
    const access = createReviewFileAccess(reader({ "big.ts": "x".repeat(10_000) }), {
      maxBytesPerFile: 1_024,
      maxTotalBytes: 2_048,
    });
    const [answer] = await access.serve(["big.ts"]);
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
    const [big, missing] = await access.serve(["big.ts", "gone.ts"]);
    expect(big.content).toBeUndefined();
    expect(big.unavailableReason).toBe(
      "present in the reviewed checkout, but larger than one request may return",
    );
    expect(missing.unavailableReason).toBe("not part of the reviewed checkout at this exact revision");
    // Neither answer may carry the filesystem.
    expect(`${big.unavailableReason} ${missing.unavailableReason}`).not.toMatch(/tmp|ENOENT/);
  });

  it("answers a repeated path once per round", async () => {
    const source = reader({ "a.ts": "a" });
    const access = createReviewFileAccess(source);
    const answers = await access.serve(["a.ts", "a.ts", "./a.ts"]);
    expect(answers).toHaveLength(1);
    expect(source.readSourceFile).toHaveBeenCalledTimes(1);
  });
});
