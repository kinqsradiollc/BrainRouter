/**
 * ADR-033 D7 — the benchmark scores what the ADR says it will be judged on,
 * and the committed dataset is real.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatReviewBenchmarkReport,
  scoreReviewCase,
  summarizeReviewBenchmark,
  type ReviewBenchmarkCase,
  type ReviewBenchmarkDataset,
} from "./reviewBenchmark.js";

/** Is `path` present at `sha` in this checkout? Used to keep the shipped ground
 *  truth findable — a defect in a file that revision lacks can never be hit. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

function gitSucceeds(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the reviewed commit in THIS clone at all?
 *
 * Separated from the file check because the two failures mean opposite things
 * and one `catch` cannot tell them apart. `actions/checkout` defaults to a
 * depth-1 clone, so on CI none of these historical commits exist — asking
 * whether a file is present at a commit the clone has never seen answers "no"
 * for a dataset that is perfectly sound.
 */
function revisionPresent(sha: string): boolean {
  return gitSucceeds(["cat-file", "-e", `${sha}^{commit}`]);
}

/** Is the file present at that revision? Only meaningful once the revision is. */
function fileExistsAtRevision(sha: string, path: string): boolean {
  return gitSucceeds(["cat-file", "-e", `${sha}:${path}`]);
}

const CASE: ReviewBenchmarkCase = {
  id: "pr-1",
  pr: 1,
  sha: "abc123",
  title: "feat: something (#1)",
  defects: [
    { file: "src/pay.ts", line: 42, description: "fix: rate could be undefined", fixedBy: "deadbeef" },
    { file: "src/cart.ts", line: 10, description: "fix: off-by-one", fixedBy: "cafebabe" },
  ],
};

describe("review benchmark scoring", () => {
  it("separates finding the bug from putting it on the right line", () => {
    const score = scoreReviewCase(CASE, {
      caseId: CASE.id,
      findings: [
        { file: "src/pay.ts", line: 43, severity: "high", summary: "rate may be undefined" },
        { file: "src/cart.ts", line: 400, severity: "high", summary: "loop bound" },
        { file: "src/other.ts", line: 3, severity: "low", summary: "nit nobody asked for" },
      ],
      wallClockMs: 1_000,
      promptChars: 5_000,
      completionChars: 900,
      modelCalls: 3,
    });
    expect(score).toMatchObject({
      truePositives: 2,
      falsePositives: 1,
      missed: 0,
      onTheRightLine: 1, // the cart finding found the file but not the place
    });
  });

  it("counts a second finding on an already-matched defect as a false positive", () => {
    const score = scoreReviewCase(CASE, {
      caseId: CASE.id,
      findings: [
        { file: "src/pay.ts", line: 42, severity: "high", summary: "rate may be undefined" },
        { file: "src/pay.ts", line: 42, severity: "low", summary: "same thing, said twice" },
      ],
      wallClockMs: 10,
      promptChars: 10,
      completionChars: 4,
      modelCalls: 1,
    });
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1);
    expect(score.missed).toBe(1);
  });

  it("reports precision, recall and cost together, with the bias attached", () => {
    const report = summarizeReviewBenchmark([
      scoreReviewCase(CASE, {
        caseId: CASE.id,
        findings: [{ file: "src/pay.ts", line: 42, severity: "high", summary: "rate" }],
        wallClockMs: 2_000,
        promptChars: 1_234,
        completionChars: 321,
        modelCalls: 2,
      }),
    ]);
    expect(report.filePrecision).toBe(1);
    expect(report.linePrecision).toBe(1);
    expect(report.recall).toBe(0.5); // one of two known defects — the trade D6 names
    expect(report.positionAccuracy).toBe(1);
    expect(report.totalModelCalls).toBe(2);
    expect(report.totalCompletionChars).toBe(321);
    const rendered = formatReviewBenchmarkReport(report, "harvested from merged pull requests");
    expect(rendered).toContain("precision (right file): 100.0%");
    expect(rendered).toContain("precision (right line): 100.0%");
    expect(rendered).toContain("completion characters: 321");
    expect(rendered).toContain("Ground truth: harvested from merged pull requests");
  });

  it("a reviewer that reports nothing scores zero precision, not a perfect one", () => {
    const report = summarizeReviewBenchmark([
      scoreReviewCase(CASE, {
        caseId: CASE.id, findings: [], wallClockMs: 1, promptChars: 1, completionChars: 0, modelCalls: 1,
      }),
    ]);
    expect(report.filePrecision).toBe(0);
    expect(report.linePrecision).toBe(0);
    expect(report.recall).toBe(0);
  });

  it("does not let a finding in the right file but the wrong place inflate line precision", () => {
    const report = summarizeReviewBenchmark([
      scoreReviewCase(CASE, {
        caseId: CASE.id,
        // Right file, 400 lines away: a person opening this comment sees nothing.
        findings: [{ file: "src/cart.ts", line: 400, severity: "high", summary: "loop bound" }],
        wallClockMs: 1, promptChars: 1, completionChars: 1, modelCalls: 1,
      }),
    ]);
    expect(report.filePrecision).toBe(1);
    expect(report.linePrecision).toBe(0);
  });

  it("ships a real dataset harvested from our own merged pull requests", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "../../../benchmark/data/review-cases.json");
    const dataset = JSON.parse(readFileSync(path, "utf8")) as ReviewBenchmarkDataset;
    expect(dataset.cases.length).toBeGreaterThanOrEqual(10);
    expect(dataset.groundTruthBias).toMatch(/biased/i);
    let verifiedRevisions = 0;
    for (const item of dataset.cases) {
      expect(item.sha).toMatch(/^[0-9a-f]{7,40}$/);
      expect(item.defects.length).toBeGreaterThan(0);
      // Shape is checked everywhere; history is checked only where there IS
      // history. A depth-1 checkout cannot answer the question at all, and a
      // test that reads "cannot tell" as "wrong" fails on a sound dataset.
      const canCheckHistory = revisionPresent(item.sha);
      if (canCheckHistory) verifiedRevisions += 1;
      for (const defect of item.defects) {
        expect(defect.line).toBeGreaterThan(0);
        expect(defect.fixedBy).toMatch(/^[0-9a-f]{7,40}$/);
        // The reviewer is scored against the REVIEWED revision, so a defect
        // that names a file the reviewed revision does not contain is
        // unfindable by construction and depresses recall forever. This is a
        // property of the harvested data, so it holds wherever it can be read.
        if (canCheckHistory) {
          expect(fileExistsAtRevision(item.sha, defect.file)).toBe(true);
        }
      }
    }
    if (verifiedRevisions === 0) {
      // Do not let a green tick claim a check that never ran (ADR-028). The
      // shape assertions above still held; the history ones were unanswerable.
      console.warn(
        "[review-benchmark] shallow clone: dataset shape verified, "
        + "defect-file-at-revision NOT verified for any of "
        + `${dataset.cases.length} case(s).`,
      );
    }
  });
});
