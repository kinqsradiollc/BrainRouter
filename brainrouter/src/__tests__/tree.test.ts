import { describe, it, expect } from "vitest";
import { parentLevel, aggregateChunkIds, summarizeChildren, aggregateHeat } from "../memory/tree/tree.js";

describe("memory tree mechanics (MEM-5)", () => {
  it("parentLevel sits one above the highest child (empty → 0)", () => {
    expect(parentLevel([{ level: 0 }, { level: 0 }])).toBe(1);
    expect(parentLevel([{ level: 0 }, { level: 2 }])).toBe(3);
    expect(parentLevel([])).toBe(0); // degenerate; summarizeBucket never calls with empty
  });

  it("aggregateChunkIds unions order-preserving + de-duped", () => {
    expect(aggregateChunkIds([{ sourceChunkIds: ["a", "b"] }, { sourceChunkIds: ["b", "c"] }])).toEqual(["a", "b", "c"]);
  });

  it("summarizeChildren bullets non-empty summaries and truncates to budget", () => {
    expect(summarizeChildren([{ summaryMd: "one" }, { summaryMd: "  " }, { summaryMd: "two" }])).toBe("- one\n- two");
    const big = summarizeChildren([{ summaryMd: "x".repeat(50) }, { summaryMd: "y".repeat(50) }], 20);
    expect(big.length).toBe(20);
    expect(big.endsWith("…")).toBe(true);
  });

  it("aggregateHeat sums child heat", () => {
    expect(aggregateHeat([{ heatScore: 1.5 }, { heatScore: 2 }, { heatScore: 0 }])).toBe(3.5);
  });
});
