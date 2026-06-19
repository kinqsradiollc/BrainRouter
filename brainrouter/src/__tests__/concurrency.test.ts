import { describe, it, expect } from "vitest";
import { mapWithConcurrency, readEmbedConcurrency } from "../memory/util/concurrency.js";

describe("mapWithConcurrency", () => {
  it("processes all items, preserving input order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (x) => x * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("runs in parallel but never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapWithConcurrency(items, 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // proves it actually parallelized
  });

  it("handles empty input and clamps a bad limit to >= 1", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 0, async (x) => x)).toEqual([1, 2]);
  });
});

describe("readEmbedConcurrency", () => {
  it("defaults to 8, parses overrides, clamps to 64, rejects junk", () => {
    expect(readEmbedConcurrency({})).toBe(8);
    expect(readEmbedConcurrency({ BRAINROUTER_EMBED_CONCURRENCY: "4" })).toBe(4);
    expect(readEmbedConcurrency({ BRAINROUTER_EMBED_CONCURRENCY: "999" })).toBe(64);
    expect(readEmbedConcurrency({ BRAINROUTER_EMBED_CONCURRENCY: "junk" })).toBe(8);
  });
});
