/**
 * ADR-033 D2 — the repository-context budget belongs to the REVIEW, not to each
 * unit it happens to split into.
 *
 * Measured on our own corpus, a per-unit cap was the entire cost regression:
 * two cases that split one call into two units accounted for 33,028 of a 33,537
 * character excess, because each unit re-materialised the shared dependencies
 * of the other. Every case that split into genuinely unrelated units got
 * cheaper. Splitting must divide the evidence budget, never multiply it.
 */
import { describe, expect, it } from "vitest";
import { createBundleRepositoryContextResolver } from "./prompt.js";

/** Records the byte budget each unit was actually asked for. */
function recordingProjector(seen: number[]) {
  return (paths: readonly string[], _diff?: string, maxBytes?: number): string => {
    seen.push(maxBytes ?? -1);
    return `context for ${paths.join(",")}`;
  };
}

describe("review repository-context budget", () => {
  it("divides one review's budget across its units instead of giving each the whole cap", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
      reviewMaxBytes: 24 * 1024,
      unitCount: 3,
    });
    resolve(["a.ts"]);
    resolve(["b.ts"]);
    resolve(["c.ts"]);
    // 24576 / 3 = 8192 each — the review still spends one review's worth.
    expect(seen).toEqual([8192, 8192, 8192]);
    expect(seen.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(24 * 1024);
  });

  it("leaves a single-unit review exactly as it was", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
      reviewMaxBytes: 24 * 1024,
      unitCount: 1,
    });
    resolve(["a.ts"]);
    // A review that did not split must not be handed a smaller budget than
    // before this rule existed — otherwise the fix silently degrades the
    // common case to make a rare one look better.
    expect(seen).toEqual([24 * 1024]);
  });

  it("never starves a unit below the floor, however many units there are", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
      reviewMaxBytes: 24 * 1024,
      unitCount: 40,
    });
    resolve(["a.ts"]);
    // 24576/40 = 614 bytes would be a fragment that costs tokens and answers
    // nothing. A floor is the honest trade: past a point, cost control has to
    // give way or the evidence stops being evidence.
    expect(seen[0]).toBeGreaterThanOrEqual(8 * 1024);
  });

  it("keeps the caller's explicit budget authoritative", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
      reviewMaxBytes: 24 * 1024,
      unitCount: 2,
    });
    resolve(["a.ts"], "", 4096);
    expect(seen).toEqual([4096]);
  });

  it("does not change behaviour when no review budget is declared", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
    });
    resolve(["a.ts"]);
    // Undefined, not a number: the provider's own default still applies, so
    // adopting this is opt-in rather than a silent cap on every caller.
    expect(seen).toEqual([-1]);
  });

  it("caches per budget, so a re-ask at a different budget is not served a stale packet", () => {
    const seen: number[] = [];
    const resolve = createBundleRepositoryContextResolver({
      fullText: "full packet",
      contextForPaths: recordingProjector(seen),
      reviewMaxBytes: 24 * 1024,
      unitCount: 2,
    });
    resolve(["a.ts"]);
    resolve(["a.ts"]);
    expect(seen).toHaveLength(1);
    resolve(["a.ts"], "", 2048);
    expect(seen).toEqual([12288, 2048]);
  });
});
