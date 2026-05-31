import { describe, it, expect } from "vitest";
import {
  benchmarkCodeChunking,
  DEFAULT_CODE_SAMPLES,
  formatCodeRecallMd,
} from "../memory/bench/code-recall.js";

/**
 * MEM-25 (0.4.4) — code-recall benchmark: a publishable metric for how well the
 * code chunker isolates known top-level symbols (the codegraph/Semble gap).
 */

describe("benchmarkCodeChunking (MEM-25)", () => {
  it("isolates the known symbols across the built-in TS/Python/Rust fixtures", () => {
    const r = benchmarkCodeChunking(DEFAULT_CODE_SAMPLES);
    expect(r.samples).toBe(3);
    expect(r.expectedSymbols).toBe(8); // 4 ts + 2 py + 2 rs
    expect(r.symbolRecall).toBeGreaterThanOrEqual(0.875); // ≥7/8 isolated
    expect(r.symbolRecall).toBeLessThanOrEqual(1);
    expect(r.chunksPerSymbol).toBeGreaterThanOrEqual(1); // 1.0 ideal
  });

  it("reports 0 recall when the expected symbol isn't produced", () => {
    const r = benchmarkCodeChunking([{ language: "ts", code: "const x = 1;\n", expectedSymbols: ["nope"] }]);
    expect(r.expectedSymbols).toBe(1);
    expect(r.isolatedSymbols).toBe(0);
    expect(r.symbolRecall).toBe(0);
  });

  it("counts a sub-split oversized symbol once (strips the #n suffix)", () => {
    const big = ["function huge() {", ...Array.from({ length: 40 }, (_, i) => `  const x${i} = ${i};`), "}"].join("\n");
    const r = benchmarkCodeChunking([{ language: "ts", code: big, expectedSymbols: ["huge"] }]);
    expect(r.isolatedSymbols).toBe(1); // huge#1/huge#2/... collapse to `huge`
    expect(r.symbolRecall).toBe(1);
  });

  it("formats publishable markdown numbers", () => {
    const md = formatCodeRecallMd(benchmarkCodeChunking(DEFAULT_CODE_SAMPLES));
    expect(md).toMatch(/symbol recall \d/);
    expect(md).toMatch(/chunks per isolated symbol/);
  });
});
