/**
 * ADR-033 D7 — semantic scoring, clean controls, full cost, and conjunctive
 * acceptance are deterministic before any live provider is allowed to run.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertReviewBenchmarkWorkingTreeClean,
  evaluateReviewBenchmarkAcceptance,
  findingMatchesIssueSemantics,
  formatReviewBenchmarkComparison,
  parseReviewBenchmarkDataset,
  scoreReviewCase,
  summarizeReviewBenchmark,
  type ReviewBenchmarkCase,
  type ReviewBenchmarkModelCall,
  type ReviewBenchmarkRun,
} from "./reviewBenchmark.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const CASE: ReviewBenchmarkCase = {
  id: "pr-1",
  pr: 1,
  sha: "abc123",
  title: "feat: queue (#1)",
  issues: [
    {
      id: "queue-dedup-race",
      description: "Concurrent deliveries can enqueue duplicate jobs.",
      fixedBy: "deadbeef",
      locations: [{ file: "src/jobs.ts", line: 42, endLine: 45 }],
      semanticRequirements: [
        ["dedup", "idempotency"],
        ["race", "concurrent"],
        ["duplicate job", "both enqueue"],
      ],
    },
    {
      id: "stale-lease-write",
      description: "A stale worker can overwrite the replacement run.",
      fixedBy: "cafebabe",
      locations: [{ file: "src/worker.ts", line: 10 }],
      semanticRequirements: [
        ["lease", "fencing"],
        ["stale worker", "old worker"],
        ["overwrite", "write back"],
      ],
    },
  ],
};

function call(overrides: Partial<ReviewBenchmarkModelCall> = {}): ReviewBenchmarkModelCall {
  const promptChars = overrides.promptChars ?? 500;
  return {
    id: "legacy:pr-1:1",
    arm: "legacy",
    caseId: CASE.id,
    phase: "review",
    taskId: "bench",
    systemChars: 100,
    promptChars,
    promptBreakdown: {
      framingChars: promptChars,
      diffEvidenceChars: 0,
      repositoryContextChars: 0,
      servedEvidenceChars: 0,
      contractChars: 0,
      evidenceRequestChars: 0,
      reflectionEvidenceChars: 0,
      continuationChars: 0,
    },
    completionChars: 80,
    wallClockMs: 25,
    status: "ok",
    ...overrides,
  };
}

function run(findings: ReviewBenchmarkRun["findings"], calls = [call()]): ReviewBenchmarkRun {
  return { caseId: CASE.id, findings, wallClockMs: 40, calls };
}

function gitSucceeds(args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitText(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

describe("review benchmark semantic scoring", () => {
  it("requires conceptual semantics as well as the right file", () => {
    const unrelated = {
      file: "src/jobs.ts",
      line: 42,
      severity: "high",
      summary: "This error message could be clearer",
    };
    expect(findingMatchesIssueSemantics(unrelated, CASE.issues[0])).toBe(false);
    const score = scoreReviewCase(CASE, run([unrelated]));
    expect(score).toMatchObject({ truePositives: 0, falsePositives: 1, missed: 2, onTheRightLine: 0 });

    const ambiguousBasename = scoreReviewCase(CASE, run([{
      file: "jobs.ts",
      line: 42,
      severity: "high",
      summary: "Concurrent idempotency race",
      details: "Both calls enqueue a duplicate job.",
    }]));
    expect(ambiguousBasename).toMatchObject({ truePositives: 0, falsePositives: 1 });
  });

  it("matches one conceptual issue across its semantic aliases", () => {
    const score = scoreReviewCase(CASE, run([
      {
        file: "src/jobs.ts",
        line: 43,
        severity: "high",
        summary: "Idempotency has a concurrency race",
        details: "Two requests can both enqueue the same duplicate job.",
      },
    ]));
    expect(score).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      missed: 1,
      onTheRightLine: 1,
      matchedIssueIds: ["queue-dedup-race"],
      correctLineIssueIds: ["queue-dedup-race"],
    });
  });

  it("keeps semantic issue precision separate from correct-line evidence", () => {
    const score = scoreReviewCase(CASE, run([
      {
        file: "src/jobs.ts",
        line: 400,
        severity: "high",
        summary: "Concurrent idempotency race",
        details: "Both deliveries enqueue a duplicate job.",
      },
    ]));
    expect(score.truePositives).toBe(1);
    expect(score.onTheRightLine).toBe(0);
    const report = summarizeReviewBenchmark([score]);
    expect(report.issuePrecision).toBe(1);
    expect(report.linePrecision).toBe(0);
  });

  it("requires the exact curated line for acceptance while allowing nearby diagnostics explicitly", () => {
    const nearby = run([{
      file: "src/worker.ts",
      line: 11,
      severity: "high",
      summary: "A stale worker can overwrite after its lease expires",
      details: "The old worker has no fencing token before write back.",
    }]);
    expect(scoreReviewCase(CASE, nearby).onTheRightLine).toBe(0);
    expect(scoreReviewCase(CASE, nearby, 5).onTheRightLine).toBe(1);
  });

  it("rejects a dirty implementation tree as non-qualifying provenance", () => {
    expect(() => assertReviewBenchmarkWorkingTreeClean(" M src/review.ts\n?? scratch.txt\n"))
      .toThrow("requires a clean working tree");
    expect(() => assertReviewBenchmarkWorkingTreeClean("\n")).not.toThrow();
  });

  it("counts duplicate findings and findings on clean controls as false positives", () => {
    const duplicate = {
      file: "src/jobs.ts",
      line: 42,
      severity: "high",
      summary: "Idempotency race",
      details: "Concurrent calls both enqueue a duplicate job.",
    };
    const defectScore = scoreReviewCase(CASE, run([duplicate, duplicate]));
    const cleanCase: ReviewBenchmarkCase = {
      id: "pr-2",
      pr: 2,
      sha: "def456",
      title: "fix: clean (#2)",
      issues: [],
      cleanEvidence: {
        kind: "no-linked-fix",
        observedThrough: "2026-08-09T00:00:00.000Z",
        note: "No linked fix in the observation window.",
      },
    };
    const cleanScore = scoreReviewCase(cleanCase, {
      caseId: cleanCase.id,
      findings: [{ file: "src/anything.ts", line: 1, severity: "low", summary: "Unsupported nit" }],
      wallClockMs: 1,
      calls: [call({ caseId: cleanCase.id })],
    });
    const report = summarizeReviewBenchmark([defectScore, cleanScore]);
    expect(defectScore).toMatchObject({ truePositives: 1, falsePositives: 1 });
    expect(cleanScore).toMatchObject({ cleanCase: true, truePositives: 0, falsePositives: 1, missed: 0 });
    expect(report.cleanCases).toBe(1);
    expect(report.cleanCaseFalsePositives).toBe(1);
  });

  it("accounts for system, prompt, completion, provider failure, and logical failure calls", () => {
    const score = scoreReviewCase(CASE, run([], [
      call(),
      call({ id: "legacy:pr-1:2", status: "provider_failed", completionChars: 0 }),
      call({ id: "legacy:pr-1:3", status: "logical_failed", completionChars: 30 }),
    ]));
    const report = summarizeReviewBenchmark([score]);
    expect(report.totalSystemChars).toBe(300);
    expect(report.totalPromptChars).toBe(1_500);
    expect(report.totalCompletionChars).toBe(110);
    expect(report.totalModelChars).toBe(1_910);
    expect(report.totalModelCalls).toBe(3);
    expect(report.failedModelCalls).toBe(1);
    expect(report.logicalFailures).toBe(1);
  });

  it("passes acceptance only when precision rises, full character cost falls, and a real issue lands correctly", () => {
    const legacy = summarizeReviewBenchmark([
      scoreReviewCase(CASE, run([
        { file: "src/jobs.ts", line: 42, severity: "low", summary: "Unrelated style note" },
      ], [call({ systemChars: 200, promptChars: 1_000, completionChars: 200 })])),
    ]);
    const bundled = summarizeReviewBenchmark([
      scoreReviewCase(CASE, run([
        {
          file: "src/jobs.ts",
          line: 42,
          severity: "high",
          summary: "Concurrent idempotency race",
          details: "Both calls enqueue a duplicate job.",
        },
      ], [call({ arm: "bundled", systemChars: 100, promptChars: 600, completionChars: 100 })])),
    ]);
    const acceptance = evaluateReviewBenchmarkAcceptance(legacy, bundled);
    expect(acceptance).toEqual({
      passed: true,
      precisionIncreased: true,
      costDecreased: true,
      correctLineEvidence: true,
      executionSucceeded: true,
      reasons: [],
    });
    expect(formatReviewBenchmarkComparison(legacy, bundled, acceptance, "biased corpus")).toContain("acceptance: PASS");
  });

  it("does not pass when any conjunct is missing", () => {
    const base = summarizeReviewBenchmark([scoreReviewCase(CASE, run([]))]);
    const acceptance = evaluateReviewBenchmarkAcceptance(base, base);
    expect(acceptance.passed).toBe(false);
    expect(acceptance.reasons).toEqual(expect.arrayContaining([
      "Bundled semantic issue precision did not increase.",
      "Bundled total model characters did not decrease.",
      "Bundled review did not place a known real issue on the correct line.",
    ]));
  });
});

describe("review benchmark corpus", () => {
  it("fails closed on the old line-list schema", () => {
    expect(() => parseReviewBenchmarkDataset({
      generatedAt: "now",
      groundTruthBias: "old",
      cases: [{ id: "old", pr: 1, sha: "abc", title: "old", defects: [] }],
    })).toThrow("schemaVersion must be 2");
  });

  it("ships curated conceptual issues and clean pull-request controls", () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "../../../benchmark/data/review-cases.json");
    const dataset = parseReviewBenchmarkDataset(JSON.parse(readFileSync(path, "utf8")));
    expect(dataset.cases.length).toBeGreaterThanOrEqual(10);
    expect(dataset.cases.filter((item) => item.issues.length === 0).length).toBeGreaterThanOrEqual(3);
    expect(dataset.cases.some((item) => item.issues.length > 0)).toBe(true);
    expect(dataset.groundTruthBias).toMatch(/not proof/i);

    let verifiedRevisions = 0;
    for (const item of dataset.cases) {
      expect(item.sha).toMatch(/^[0-9a-f]{40}$/);
      const revisionPresent = gitSucceeds(["cat-file", "-e", `${item.sha}^{commit}`]);
      if (revisionPresent) verifiedRevisions += 1;
      if (revisionPresent && item.cleanEvidence) {
        const committedAt = Date.parse(gitText(["show", "-s", "--format=%cI", item.sha]));
        const observedThrough = Date.parse(item.cleanEvidence.observedThrough);
        expect(observedThrough - committedAt).toBeGreaterThan(30 * 24 * 60 * 60 * 1_000);
      }
      for (const issue of item.issues) {
        expect(issue.fixedBy).toMatch(/^[0-9a-f]{40}$/);
        expect(issue.semanticRequirements.length).toBeGreaterThanOrEqual(2);
        expect(issue.locations.length).toBeGreaterThan(0);
        const fixPresent = gitSucceeds(["cat-file", "-e", `${issue.fixedBy}^{commit}`]);
        if (revisionPresent && fixPresent) {
          const changedByFix = new Set(gitText([
            "diff-tree", "--no-commit-id", "--name-only", "-r", issue.fixedBy,
          ]).split("\n"));
          expect(issue.locations.some((location) => changedByFix.has(location.file))).toBe(true);
          expect(Date.parse(gitText(["show", "-s", "--format=%cI", issue.fixedBy])))
            .toBeGreaterThan(Date.parse(gitText(["show", "-s", "--format=%cI", item.sha])));
        }
        for (const location of issue.locations) {
          if (revisionPresent) {
            expect(gitSucceeds(["cat-file", "-e", `${item.sha}:${location.file}`])).toBe(true);
          }
        }
      }
    }
    if (verifiedRevisions === 0) {
      console.warn("[review-benchmark] shallow clone: semantic corpus shape verified; historical files unavailable.");
    }
  });
});
