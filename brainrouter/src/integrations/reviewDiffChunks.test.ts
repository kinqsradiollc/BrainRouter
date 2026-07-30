import { describe, it, expect } from "vitest";
import {
  changedSourceLocations,
  dedupeReviewFindings,
  splitDiffForReview,
} from "./reviewDiffChunks.js";
import type { ParsedReviewFinding } from "@kinqs/brainrouter-core/review";

const fileDiff = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

describe("splitDiffForReview", () => {
  it("returns a single chunk when the diff is within budget (unchanged single pass)", () => {
    const diff = fileDiff("a.ts", "@@ -1 +1 @@\n+const a = 1;");
    expect(splitDiffForReview(diff, 10_000)).toEqual([diff]);
  });

  it("returns [] for an empty diff", () => {
    expect(splitDiffForReview("", 100)).toEqual([]);
  });

  it("splits along file boundaries and reviews every file", () => {
    const f1 = fileDiff("one.ts", "@@ -1 +1 @@\n+" + "x".repeat(80));
    const f2 = fileDiff("two.ts", "@@ -1 +1 @@\n+" + "y".repeat(80));
    const f3 = fileDiff("three.ts", "@@ -1 +1 @@\n+" + "z".repeat(80));
    const diff = [f1, f2, f3].join("\n");
    const chunks = splitDiffForReview(diff, 140); // ~one file per chunk
    // Every file header appears exactly once across the chunks — nothing dropped.
    for (const path of ["one.ts", "two.ts", "three.ts"]) {
      expect(chunks.filter((c) => c.includes(`b/${path}`))).toHaveLength(1);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 140 || c.includes("@@"))).toBe(true);
  });

  it("splits one oversized file along hunk boundaries, keeping its header on each part", () => {
    const big = fileDiff(
      "big.ts",
      ["@@ -1 +1 @@", "+" + "a".repeat(120), "@@ -50 +50 @@", "+" + "b".repeat(120)].join("\n"),
    );
    const chunks = splitDiffForReview(big, 160);
    expect(chunks.length).toBeGreaterThan(1);
    // Each piece keeps the file header so it is a self-describing diff.
    for (const chunk of chunks) expect(chunk).toContain("+++ b/big.ts");
  });

  it("keeps an indivisible giant hunk whole rather than mangling it", () => {
    const giant = fileDiff("g.ts", "@@ -1 +1 @@\n+" + "q".repeat(500));
    const chunks = splitDiffForReview(giant, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("q".repeat(500));
  });
});

describe("dedupeReviewFindings", () => {
  const f = (over: Partial<ParsedReviewFinding>): ParsedReviewFinding =>
    ({ file: "a.ts", severity: "high", confidence: 0.9, summary: "SQL injection", ...over });

  it("drops duplicates by file+line+summary and keeps distinct findings", () => {
    const out = dedupeReviewFindings([
      f({ file: "a.ts", line: 10, summary: "SQL injection" }),
      f({ file: "a.ts", line: 10, summary: "sql injection" }), // same (case-insensitive)
      f({ file: "a.ts", line: 20, summary: "SQL injection" }), // different line
      f({ file: "b.ts", line: 10, summary: "SQL injection" }), // different file
      f({ file: "a.ts", line: 10, summary: "XSS" }),           // different summary
    ]);
    expect(out).toHaveLength(4);
  });

  it("preserves order of first occurrence", () => {
    const out = dedupeReviewFindings([
      f({ line: 1, summary: "first" }),
      f({ line: 2, summary: "second" }),
      f({ line: 1, summary: "first" }),
    ]);
    expect(out.map((x) => x.summary)).toEqual(["first", "second"]);
  });
});

describe("changedSourceLocations", () => {
  it("groups contiguous additions and retains deletion-only files", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,4 @@",
      " context",
      "+first",
      "+second",
      " context",
      "+third",
      "diff --git a/src/removed.ts b/src/removed.ts",
      "--- a/src/removed.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n");

    expect(changedSourceLocations(diff)).toEqual([
      { path: "src/a.ts", line: 11, endLine: 12 },
      { path: "src/a.ts", line: 14 },
      { path: "src/removed.ts" },
    ]);
  });
});
