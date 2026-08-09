/**
 * ADR-033 D7 — measure the reviewer, or every decision about it is a belief.
 *
 * This is the scoring half of the benchmark: pure functions that take a case's
 * ground truth and a review's findings and produce precision, recall, and — the
 * number this ADR actually cares about — how often a true finding landed on the
 * RIGHT LINE. Wall-clock and token counts ride along because "higher precision
 * at a fraction of the tokens" is a claim with two halves and both must be
 * checked.
 *
 * ## Where the ground truth comes from, and how it is biased
 *
 * Cases are harvested from OUR OWN merged pull requests: a later `fix(...)`
 * commit that changed a line, blamed back to the merged PR that introduced that
 * line. The defect location is therefore a place we know was wrong, because we
 * later fixed it.
 *
 * That is real, and it is biased in three ways worth stating plainly rather
 * than discovering later:
 *
 *  1. **Only defects we noticed.** A bug still sitting in the tree is not in the
 *     dataset, so recall here is recall against *found* bugs, not all bugs.
 *  2. **Only defects fixed as their own commit.** A bug corrected inside the
 *     same PR, or in a refactor, leaves no `fix(...)` trace to harvest.
 *  3. **Toward what our tooling and reviewers already catch**, since those are
 *     the ones that turn into fix commits at all.
 *
 * So the absolute numbers mean little; the DELTA between two reviewer versions
 * on the same frozen set is what the ADR is asking for.
 */

/** One known defect location in a merged pull request. */
export interface ReviewBenchmarkDefect {
  file: string;
  line: number;
  /** The fix commit's subject — what the defect turned out to be. */
  description: string;
  /** The commit that fixed it, for anyone auditing a case by hand. */
  fixedBy: string;
}

export interface ReviewBenchmarkCase {
  id: string;
  /** Our own merged pull request number. */
  pr: number;
  /** The merge commit the diff is taken from. */
  sha: string;
  title: string;
  defects: ReviewBenchmarkDefect[];
}

export interface ReviewBenchmarkDataset {
  generatedAt: string;
  /** Restated in the data file so nobody reads the numbers without the caveat. */
  groundTruthBias: string;
  cases: ReviewBenchmarkCase[];
}

/** What a reviewer produced for one case, plus what it cost. */
export interface ReviewBenchmarkRun {
  caseId: string;
  findings: Array<{ file: string; line?: number; severity: string; summary: string }>;
  wallClockMs: number;
  promptChars: number;
  /**
   * Characters the model GENERATED. Counted because §6's claim is "tokens per
   * review go down", and prompt size alone cannot settle that: the reflection
   * pass and the D3 second round are extra generations, not extra prompt.
   */
  completionChars: number;
  modelCalls: number;
}

export interface ReviewBenchmarkCaseScore {
  caseId: string;
  truePositives: number;
  falsePositives: number;
  missed: number;
  /** True positives that also landed within the line tolerance. */
  onTheRightLine: number;
  wallClockMs: number;
  promptChars: number;
  completionChars: number;
  modelCalls: number;
}

export interface ReviewBenchmarkReport {
  cases: ReviewBenchmarkCaseScore[];
  /**
   * FILE-level: a finding counts when it names a file that holds a known
   * defect. Named for what it measures, because reading it as the headline is
   * how a reviewer that comments anywhere in the right file scores as precise.
   */
  filePrecision: number;
  /**
   * LINE-level: the same findings, counted only when they also landed within
   * the tolerance. This is the number ADR-033 §6's "the right line, not the
   * right file" is asking about, so it is reported rather than left derivable.
   */
  linePrecision: number;
  recall: number;
  /** Of the findings that matched a real defect, the share on the right line. */
  positionAccuracy: number;
  totalWallClockMs: number;
  totalPromptChars: number;
  totalCompletionChars: number;
  totalModelCalls: number;
}

/**
 * How far from the recorded defect line a finding may sit and still count as
 * the same issue. Small on purpose: this is the number that decides whether
 * "found it" means a person looking at the comment sees the problem.
 */
export const DEFAULT_LINE_TOLERANCE = 5;

function samePath(left: string, right: string): boolean {
  const a = left.replace(/^\.?\//, '');
  const b = right.replace(/^\.?\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** Score one case. A defect is matched by at most one finding, and vice versa. */
export function scoreReviewCase(
  benchmarkCase: ReviewBenchmarkCase,
  run: ReviewBenchmarkRun,
  lineTolerance = DEFAULT_LINE_TOLERANCE,
): ReviewBenchmarkCaseScore {
  const unmatched = new Set(benchmarkCase.defects.map((_, index) => index));
  let truePositives = 0;
  let onTheRightLine = 0;
  let falsePositives = 0;

  for (const finding of run.findings) {
    let matched: number | null = null;
    let matchedOnLine = false;
    for (const index of unmatched) {
      const defect = benchmarkCase.defects[index];
      if (!samePath(finding.file, defect.file)) continue;
      const distance = typeof finding.line === 'number' ? Math.abs(finding.line - defect.line) : Infinity;
      // A finding on the right file counts as found; being on the right line is
      // scored separately, because that is the difference between a person
      // seeing the problem and a person seeing nothing there.
      if (matched === null || distance <= lineTolerance) {
        matched = index;
        matchedOnLine = distance <= lineTolerance;
        if (matchedOnLine) break;
      }
    }
    if (matched === null) {
      falsePositives += 1;
      continue;
    }
    unmatched.delete(matched);
    truePositives += 1;
    if (matchedOnLine) onTheRightLine += 1;
  }

  return {
    caseId: benchmarkCase.id,
    truePositives,
    falsePositives,
    missed: unmatched.size,
    onTheRightLine,
    wallClockMs: run.wallClockMs,
    promptChars: run.promptChars,
    completionChars: run.completionChars,
    modelCalls: run.modelCalls,
  };
}

export function summarizeReviewBenchmark(scores: readonly ReviewBenchmarkCaseScore[]): ReviewBenchmarkReport {
  const total = scores.reduce(
    (sum, score) => ({
      truePositives: sum.truePositives + score.truePositives,
      falsePositives: sum.falsePositives + score.falsePositives,
      missed: sum.missed + score.missed,
      onTheRightLine: sum.onTheRightLine + score.onTheRightLine,
      wallClockMs: sum.wallClockMs + score.wallClockMs,
      promptChars: sum.promptChars + score.promptChars,
      completionChars: sum.completionChars + score.completionChars,
      modelCalls: sum.modelCalls + score.modelCalls,
    }),
    {
      truePositives: 0, falsePositives: 0, missed: 0, onTheRightLine: 0,
      wallClockMs: 0, promptChars: 0, completionChars: 0, modelCalls: 0,
    },
  );
  const reported = total.truePositives + total.falsePositives;
  const known = total.truePositives + total.missed;
  return {
    cases: [...scores],
    filePrecision: reported === 0 ? 0 : total.truePositives / reported,
    linePrecision: reported === 0 ? 0 : total.onTheRightLine / reported,
    recall: known === 0 ? 0 : total.truePositives / known,
    positionAccuracy: total.truePositives === 0 ? 0 : total.onTheRightLine / total.truePositives,
    totalWallClockMs: total.wallClockMs,
    totalPromptChars: total.promptChars,
    totalCompletionChars: total.completionChars,
    totalModelCalls: total.modelCalls,
  };
}

/** Render a report the way it should be read: with its bias attached. */
export function formatReviewBenchmarkReport(
  report: ReviewBenchmarkReport,
  bias: string,
): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `cases: ${report.cases.length}`,
    `precision (right file): ${percent(report.filePrecision)}`,
    `precision (right line): ${percent(report.linePrecision)}`,
    `recall: ${percent(report.recall)}`,
    `on the right line: ${percent(report.positionAccuracy)} of true findings`,
    `model calls: ${report.totalModelCalls}`,
    `prompt characters: ${report.totalPromptChars}`,
    `completion characters: ${report.totalCompletionChars}`,
    `wall clock: ${(report.totalWallClockMs / 1000).toFixed(1)}s`,
    '',
    `Ground truth: ${bias}`,
  ].join('\n');
}
