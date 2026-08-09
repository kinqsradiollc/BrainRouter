/**
 * ADR-033 D7 — semantic review-benchmark contracts, scoring, and acceptance.
 *
 * A file/line coincidence is not a true positive: one file can contain several
 * unrelated defects, and a generic comment beside any of them proves nothing.
 * Ground truth therefore names one conceptual issue once, gives that issue all
 * eligible locations, and supplies curated semantic requirements. A finding
 * matches only when its text satisfies every requirement group and its path is
 * one of the issue's locations. Position remains a separate, stricter measure.
 *
 * Clean pull requests are first-class negative controls. Their empty issue set
 * is backed by an explicit observation statement, not a claim that the change
 * is mathematically bug-free. Any finding on one is a false positive.
 */

export interface ReviewBenchmarkLocation {
  file: string;
  line: number;
  endLine?: number;
}

/** One conceptual defect, possibly visible at several related source lines. */
export interface ReviewBenchmarkIssue {
  id: string;
  description: string;
  fixedBy: string;
  locations: ReviewBenchmarkLocation[];
  /**
   * AND across groups, OR within a group. For example
   * `[["lease", "fencing"], ["stale worker", "overwrite"]]` requires one
   * phrase from each group. These aliases are curated from the actual fix.
   */
  semanticRequirements: string[][];
}

export interface ReviewBenchmarkCleanEvidence {
  kind: "no-linked-fix";
  observedThrough: string;
  note: string;
}

export interface ReviewBenchmarkCase {
  id: string;
  pr: number;
  sha: string;
  title: string;
  issues: ReviewBenchmarkIssue[];
  /** Required exactly when `issues` is empty. */
  cleanEvidence?: ReviewBenchmarkCleanEvidence;
}

export interface ReviewBenchmarkDataset {
  schemaVersion: 2;
  generatedAt: string;
  observationCutoff: string;
  /** Restated in the data so absolute scores are never detached from bias. */
  groundTruthBias: string;
  cases: ReviewBenchmarkCase[];
}

export interface ReviewBenchmarkFinding {
  file: string;
  line?: number;
  severity: string;
  summary: string;
  details?: string;
  suggestion?: string;
  codeExcerpt?: string;
}

export type ReviewBenchmarkModelCallStatus = "ok" | "provider_failed" | "logical_failed";

/** Exact prompt components, so a cost regression names what grew. */
export interface ReviewBenchmarkPromptCostBreakdown {
  framingChars: number;
  diffEvidenceChars: number;
  repositoryContextChars: number;
  servedEvidenceChars: number;
  contractChars: number;
  evidenceRequestChars: number;
  reflectionEvidenceChars: number;
  continuationChars: number;
}

/** One actual provider attempt, including failed and malformed-output calls. */
export interface ReviewBenchmarkModelCall {
  id: string;
  arm: "legacy" | "bundled";
  caseId: string;
  phase: string;
  taskId: string;
  systemChars: number;
  promptChars: number;
  promptBreakdown: ReviewBenchmarkPromptCostBreakdown;
  completionChars: number;
  wallClockMs: number;
  status: ReviewBenchmarkModelCallStatus;
  error?: string;
}

/** What one arm produced for one case, plus the complete provider ledger. */
export interface ReviewBenchmarkRun {
  caseId: string;
  findings: ReviewBenchmarkFinding[];
  wallClockMs: number;
  calls: ReviewBenchmarkModelCall[];
}

export interface ReviewBenchmarkCaseScore {
  caseId: string;
  cleanCase: boolean;
  truePositives: number;
  falsePositives: number;
  missed: number;
  /** Semantically matched issues that also landed within the line tolerance. */
  onTheRightLine: number;
  matchedIssueIds: string[];
  correctLineIssueIds: string[];
  wallClockMs: number;
  systemChars: number;
  promptChars: number;
  completionChars: number;
  modelCalls: number;
  failedModelCalls: number;
  logicalFailures: number;
}

export interface ReviewBenchmarkReport {
  cases: ReviewBenchmarkCaseScore[];
  /** Semantic issue precision; path-only coincidences never enter this count. */
  issuePrecision: number;
  /** Semantic issue matches that also point at the right line, per finding. */
  linePrecision: number;
  recall: number;
  positionAccuracy: number;
  cleanCases: number;
  cleanCaseFalsePositives: number;
  totalWallClockMs: number;
  totalSystemChars: number;
  totalPromptChars: number;
  totalCompletionChars: number;
  totalModelChars: number;
  totalModelCalls: number;
  failedModelCalls: number;
  logicalFailures: number;
}

export interface ReviewBenchmarkAcceptance {
  passed: boolean;
  precisionIncreased: boolean;
  costDecreased: boolean;
  correctLineEvidence: boolean;
  executionSucceeded: boolean;
  reasons: string[];
}

/** Acceptance is exact: a nearby line may be diagnostic, but is not correct. */
export const DEFAULT_LINE_TOLERANCE = 0;

/** A dirty implementation tree cannot produce qualifying benchmark evidence. */
export function assertReviewBenchmarkWorkingTreeClean(statusPorcelain: string): void {
  if (String(statusPorcelain ?? '').trim()) {
    throw new Error(
      'Review benchmark requires a clean working tree so its implementation provenance is complete.',
    );
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function fullCommitSha(value: unknown, label: string): string {
  const sha = requiredString(value, label);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${label} must be a full 40-character commit SHA.`);
  return sha.toLowerCase();
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)
    || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return timestamp;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Number(value);
}

function parseLocation(value: unknown, label: string): ReviewBenchmarkLocation {
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`);
  const raw = value as Record<string, unknown>;
  const line = positiveInteger(raw.line, `${label}.line`);
  const endLine = raw.endLine === undefined ? undefined : positiveInteger(raw.endLine, `${label}.endLine`);
  if (endLine !== undefined && endLine < line) {
    throw new Error(`${label}.endLine must not precede line.`);
  }
  return {
    file: requiredString(raw.file, `${label}.file`),
    line,
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

function parseSemanticRequirements(value: unknown, label: string): string[][] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${label} must contain at least two requirement groups.`);
  }
  return value.map((group, groupIndex) => {
    if (!Array.isArray(group) || group.length === 0) {
      throw new Error(`${label}[${groupIndex}] must contain at least one phrase.`);
    }
    return group.map((entry, entryIndex) => {
      const phrase = requiredString(entry, `${label}[${groupIndex}][${entryIndex}]`);
      if (!/[a-z0-9]/i.test(phrase)) {
        throw new Error(`${label}[${groupIndex}][${entryIndex}] must contain searchable text.`);
      }
      return phrase;
    });
  });
}

function parseIssue(value: unknown, caseId: string, index: number): ReviewBenchmarkIssue {
  const label = `${caseId}.issues[${index}]`;
  if (!value || typeof value !== "object") throw new Error(`${label} must be an object.`);
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.locations) || raw.locations.length === 0) {
    throw new Error(`${label}.locations must contain at least one source location.`);
  }
  return {
    id: requiredString(raw.id, `${label}.id`),
    description: requiredString(raw.description, `${label}.description`),
    fixedBy: fullCommitSha(raw.fixedBy, `${label}.fixedBy`),
    locations: raw.locations.map((location, locationIndex) =>
      parseLocation(location, `${label}.locations[${locationIndex}]`)),
    semanticRequirements: parseSemanticRequirements(raw.semanticRequirements, `${label}.semanticRequirements`),
  };
}

function parseCleanEvidence(value: unknown, caseId: string): ReviewBenchmarkCleanEvidence {
  if (!value || typeof value !== "object") throw new Error(`${caseId}.cleanEvidence is required for a clean case.`);
  const raw = value as Record<string, unknown>;
  if (raw.kind !== "no-linked-fix") {
    throw new Error(`${caseId}.cleanEvidence.kind must be "no-linked-fix".`);
  }
  return {
    kind: "no-linked-fix",
    observedThrough: isoTimestamp(raw.observedThrough, `${caseId}.cleanEvidence.observedThrough`),
    note: requiredString(raw.note, `${caseId}.cleanEvidence.note`),
  };
}

function assertUniqueIssueLocations(issues: readonly ReviewBenchmarkIssue[], caseId: string): void {
  const seen = new Map<string, string>();
  for (const issue of issues) {
    for (const location of issue.locations) {
      const key = `${location.file}:${location.line}:${location.endLine ?? location.line}`;
      const previous = seen.get(key);
      if (previous && previous !== issue.id) {
        throw new Error(`${caseId} assigns ${key} to both ${previous} and ${issue.id}.`);
      }
      seen.set(key, issue.id);
    }
  }
}

function parseCase(value: unknown, index: number, issueIds: Set<string>): ReviewBenchmarkCase {
  if (!value || typeof value !== "object") throw new Error(`cases[${index}] must be an object.`);
  const raw = value as Record<string, unknown>;
  const id = requiredString(raw.id, `cases[${index}].id`);
  if (!Array.isArray(raw.issues)) throw new Error(`${id}.issues must be an array.`);
  const issues = raw.issues.map((issue, issueIndex) => parseIssue(issue, id, issueIndex));
  for (const issue of issues) {
    if (issueIds.has(issue.id)) throw new Error(`Duplicate benchmark issue id: ${issue.id}.`);
    issueIds.add(issue.id);
  }
  assertUniqueIssueLocations(issues, id);
  if (issues.length > 0 && raw.cleanEvidence !== undefined) {
    throw new Error(`${id} cannot carry cleanEvidence when it has known issues.`);
  }
  return {
    id,
    pr: positiveInteger(raw.pr, `${id}.pr`),
    sha: fullCommitSha(raw.sha, `${id}.sha`),
    title: requiredString(raw.title, `${id}.title`),
    issues,
    ...(issues.length === 0 ? { cleanEvidence: parseCleanEvidence(raw.cleanEvidence, id) } : {}),
  };
}

/** Parse and validate the frozen semantic corpus; legacy line-list data fails closed. */
export function parseReviewBenchmarkDataset(value: unknown): ReviewBenchmarkDataset {
  if (!value || typeof value !== "object") throw new Error("Review benchmark dataset must be an object.");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 2) throw new Error("Review benchmark dataset schemaVersion must be 2.");
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error("Review benchmark dataset must contain cases.");
  }
  const issueIds = new Set<string>();
  const cases = raw.cases.map((entry, index) => parseCase(entry, index, issueIds));
  const caseIds = new Set(cases.map((entry) => entry.id));
  if (caseIds.size !== cases.length) throw new Error("Review benchmark case ids must be unique.");
  const pullRequests = new Set(cases.map((entry) => entry.pr));
  if (pullRequests.size !== cases.length) throw new Error("Review benchmark pull requests must be unique.");
  if (!cases.some((entry) => entry.issues.length === 0)) {
    throw new Error("Review benchmark dataset must include at least one clean pull request.");
  }
  if (!cases.some((entry) => entry.issues.length > 0)) {
    throw new Error("Review benchmark dataset must include at least one pull request with a known issue.");
  }
  const generatedAt = isoTimestamp(raw.generatedAt, "generatedAt");
  const observationCutoff = isoTimestamp(raw.observationCutoff, "observationCutoff");
  if (Date.parse(observationCutoff) > Date.parse(generatedAt)) {
    throw new Error("observationCutoff must not be later than generatedAt.");
  }
  for (const benchmarkCase of cases) {
    if (benchmarkCase.cleanEvidence
      && Date.parse(benchmarkCase.cleanEvidence.observedThrough) > Date.parse(observationCutoff)) {
      throw new Error(`${benchmarkCase.id}.cleanEvidence.observedThrough must not exceed observationCutoff.`);
    }
  }
  return {
    schemaVersion: 2,
    generatedAt,
    observationCutoff,
    groundTruthBias: requiredString(raw.groundTruthBias, "groundTruthBias"),
    cases,
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalize(left) === normalize(right);
}

function findingText(finding: ReviewBenchmarkFinding): string {
  return normalizeText([
    finding.summary,
    finding.details,
    finding.suggestion,
    finding.codeExcerpt,
  ].filter((entry): entry is string => Boolean(entry)).join(" "));
}

/** Exported so matcher behavior is reviewable and unit-testable without a model. */
export function findingMatchesIssueSemantics(
  finding: ReviewBenchmarkFinding,
  issue: ReviewBenchmarkIssue,
): boolean {
  const text = findingText(finding);
  return issue.semanticRequirements.every((group) =>
    group.some((phrase) => text.includes(normalizeText(phrase))));
}

function issueLocationMatch(
  finding: ReviewBenchmarkFinding,
  issue: ReviewBenchmarkIssue,
  lineTolerance: number,
): { path: boolean; line: boolean; distance: number } {
  const locations = issue.locations.filter((location) => samePath(finding.file, location.file));
  if (locations.length === 0) return { path: false, line: false, distance: Infinity };
  const distance = typeof finding.line === "number"
    ? Math.min(...locations.map((location) => {
        const end = location.endLine ?? location.line;
        if (finding.line! < location.line) return location.line - finding.line!;
        if (finding.line! > end) return finding.line! - end;
        return 0;
      }))
    : Infinity;
  return { path: true, line: distance <= lineTolerance, distance };
}

function matchFinding(
  finding: ReviewBenchmarkFinding,
  benchmarkCase: ReviewBenchmarkCase,
  unmatched: Set<number>,
  lineTolerance: number,
): { issueIndex: number; onLine: boolean } | null {
  const candidates = [...unmatched]
    .map((issueIndex) => {
      const issue = benchmarkCase.issues[issueIndex];
      if (!findingMatchesIssueSemantics(finding, issue)) return null;
      const location = issueLocationMatch(finding, issue, lineTolerance);
      return location.path ? { issueIndex, onLine: location.line, distance: location.distance } : null;
    })
    .filter((candidate): candidate is { issueIndex: number; onLine: boolean; distance: number } => Boolean(candidate))
    .sort((left, right) => Number(right.onLine) - Number(left.onLine) || left.distance - right.distance);
  return candidates[0] ? { issueIndex: candidates[0].issueIndex, onLine: candidates[0].onLine } : null;
}

/** Score one case. Each finding and each conceptual issue can match only once. */
export function scoreReviewCase(
  benchmarkCase: ReviewBenchmarkCase,
  run: ReviewBenchmarkRun,
  lineTolerance = DEFAULT_LINE_TOLERANCE,
): ReviewBenchmarkCaseScore {
  if (run.caseId !== benchmarkCase.id) {
    throw new Error(`Benchmark run ${run.caseId} cannot be scored as ${benchmarkCase.id}.`);
  }
  if (!Number.isFinite(run.wallClockMs) || run.wallClockMs < 0) {
    throw new Error(`${run.caseId} has an invalid wall-clock duration.`);
  }
  const callIds = new Set<string>();
  for (const modelCall of run.calls) {
    if (modelCall.caseId !== benchmarkCase.id) {
      throw new Error(`${run.caseId} contains a model call for ${modelCall.caseId}.`);
    }
    if (callIds.has(modelCall.id)) throw new Error(`${run.caseId} contains duplicate model call ${modelCall.id}.`);
    callIds.add(modelCall.id);
    for (const [label, value] of Object.entries({
      systemChars: modelCall.systemChars,
      promptChars: modelCall.promptChars,
      completionChars: modelCall.completionChars,
      wallClockMs: modelCall.wallClockMs,
    })) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${modelCall.id}.${label} must be non-negative.`);
    }
    const promptBreakdownChars = Object.values(modelCall.promptBreakdown).reduce((sum, value) => {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${modelCall.id}.promptBreakdown must contain only non-negative values.`);
      }
      return sum + value;
    }, 0);
    if (promptBreakdownChars !== modelCall.promptChars) {
      throw new Error(`${modelCall.id}.promptBreakdown must equal promptChars.`);
    }
  }
  const unmatched = new Set(benchmarkCase.issues.map((_, index) => index));
  const matchedIssueIds: string[] = [];
  const correctLineIssueIds: string[] = [];
  let falsePositives = 0;

  for (const finding of run.findings) {
    const matched = matchFinding(finding, benchmarkCase, unmatched, lineTolerance);
    if (!matched) {
      falsePositives += 1;
      continue;
    }
    unmatched.delete(matched.issueIndex);
    const issueId = benchmarkCase.issues[matched.issueIndex].id;
    matchedIssueIds.push(issueId);
    if (matched.onLine) correctLineIssueIds.push(issueId);
  }

  const systemChars = run.calls.reduce((sum, call) => sum + call.systemChars, 0);
  const promptChars = run.calls.reduce((sum, call) => sum + call.promptChars, 0);
  const completionChars = run.calls.reduce((sum, call) => sum + call.completionChars, 0);
  return {
    caseId: benchmarkCase.id,
    cleanCase: benchmarkCase.issues.length === 0,
    truePositives: matchedIssueIds.length,
    falsePositives,
    missed: unmatched.size,
    onTheRightLine: correctLineIssueIds.length,
    matchedIssueIds,
    correctLineIssueIds,
    wallClockMs: run.wallClockMs,
    systemChars,
    promptChars,
    completionChars,
    modelCalls: run.calls.length,
    failedModelCalls: run.calls.filter((call) => call.status === "provider_failed").length,
    logicalFailures: run.calls.filter((call) => call.status === "logical_failed").length,
  };
}

interface ScoreTotals {
  truePositives: number;
  falsePositives: number;
  missed: number;
  onTheRightLine: number;
  wallClockMs: number;
  systemChars: number;
  promptChars: number;
  completionChars: number;
  modelCalls: number;
  failedModelCalls: number;
  logicalFailures: number;
  cleanCases: number;
  cleanCaseFalsePositives: number;
}

function addScore(sum: ScoreTotals, score: ReviewBenchmarkCaseScore): ScoreTotals {
  return {
    truePositives: sum.truePositives + score.truePositives,
    falsePositives: sum.falsePositives + score.falsePositives,
    missed: sum.missed + score.missed,
    onTheRightLine: sum.onTheRightLine + score.onTheRightLine,
    wallClockMs: sum.wallClockMs + score.wallClockMs,
    systemChars: sum.systemChars + score.systemChars,
    promptChars: sum.promptChars + score.promptChars,
    completionChars: sum.completionChars + score.completionChars,
    modelCalls: sum.modelCalls + score.modelCalls,
    failedModelCalls: sum.failedModelCalls + score.failedModelCalls,
    logicalFailures: sum.logicalFailures + score.logicalFailures,
    cleanCases: sum.cleanCases + Number(score.cleanCase),
    cleanCaseFalsePositives: sum.cleanCaseFalsePositives + (score.cleanCase ? score.falsePositives : 0),
  };
}

const EMPTY_TOTALS: ScoreTotals = {
  truePositives: 0,
  falsePositives: 0,
  missed: 0,
  onTheRightLine: 0,
  wallClockMs: 0,
  systemChars: 0,
  promptChars: 0,
  completionChars: 0,
  modelCalls: 0,
  failedModelCalls: 0,
  logicalFailures: 0,
  cleanCases: 0,
  cleanCaseFalsePositives: 0,
};

export function summarizeReviewBenchmark(scores: readonly ReviewBenchmarkCaseScore[]): ReviewBenchmarkReport {
  const total = scores.reduce(addScore, EMPTY_TOTALS);
  const reported = total.truePositives + total.falsePositives;
  const known = total.truePositives + total.missed;
  return {
    cases: [...scores],
    issuePrecision: reported === 0 ? 0 : total.truePositives / reported,
    linePrecision: reported === 0 ? 0 : total.onTheRightLine / reported,
    recall: known === 0 ? 0 : total.truePositives / known,
    positionAccuracy: total.truePositives === 0 ? 0 : total.onTheRightLine / total.truePositives,
    cleanCases: total.cleanCases,
    cleanCaseFalsePositives: total.cleanCaseFalsePositives,
    totalWallClockMs: total.wallClockMs,
    totalSystemChars: total.systemChars,
    totalPromptChars: total.promptChars,
    totalCompletionChars: total.completionChars,
    totalModelChars: total.systemChars + total.promptChars + total.completionChars,
    totalModelCalls: total.modelCalls,
    failedModelCalls: total.failedModelCalls,
    logicalFailures: total.logicalFailures,
  };
}

/** ADR-033 §6 is conjunctive: precision up, cost down, and a real right-line hit. */
export function evaluateReviewBenchmarkAcceptance(
  legacy: ReviewBenchmarkReport,
  bundled: ReviewBenchmarkReport,
): ReviewBenchmarkAcceptance {
  const precisionIncreased = bundled.issuePrecision > legacy.issuePrecision;
  const costDecreased = bundled.totalModelChars < legacy.totalModelChars;
  const correctLineEvidence = bundled.cases.some((score) => score.correctLineIssueIds.length > 0);
  const executionSucceeded = [legacy, bundled].every(
    (report) => report.failedModelCalls === 0 && report.logicalFailures === 0 && report.cases.length > 0,
  );
  const reasons = [
    ...(precisionIncreased ? [] : ["Bundled semantic issue precision did not increase."]),
    ...(costDecreased ? [] : ["Bundled total model characters did not decrease."]),
    ...(correctLineEvidence ? [] : ["Bundled review did not place a known real issue on the correct line."]),
    ...(executionSucceeded ? [] : ["At least one arm had a provider or logical-output failure."]),
  ];
  return {
    passed: precisionIncreased && costDecreased && correctLineEvidence && executionSucceeded,
    precisionIncreased,
    costDecreased,
    correctLineEvidence,
    executionSucceeded,
    reasons,
  };
}

/** Render one arm with every character class visible, including system text. */
export function formatReviewBenchmarkReport(report: ReviewBenchmarkReport, bias: string): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  return [
    `cases: ${report.cases.length} (${report.cleanCases} clean controls)`,
    `precision (semantic issue): ${percent(report.issuePrecision)}`,
    `precision (semantic issue + right line): ${percent(report.linePrecision)}`,
    `recall: ${percent(report.recall)}`,
    `on the right line: ${percent(report.positionAccuracy)} of true findings`,
    `false positives on clean controls: ${report.cleanCaseFalsePositives}`,
    `model calls: ${report.totalModelCalls} (${report.failedModelCalls} provider, ${report.logicalFailures} logical failures)`,
    `system characters: ${report.totalSystemChars}`,
    `prompt characters: ${report.totalPromptChars}`,
    `completion characters: ${report.totalCompletionChars}`,
    `total model characters: ${report.totalModelChars}`,
    `wall clock: ${(report.totalWallClockMs / 1000).toFixed(1)}s`,
    "",
    `Ground truth: ${bias}`,
  ].join("\n");
}

export function formatReviewBenchmarkComparison(
  legacy: ReviewBenchmarkReport,
  bundled: ReviewBenchmarkReport,
  acceptance: ReviewBenchmarkAcceptance,
  bias: string,
): string {
  const delta = (next: number, previous: number): string => {
    const sign = next - previous > 0 ? "+" : "";
    return `${sign}${(next - previous).toFixed(4)}`;
  };
  return [
    "LEGACY",
    formatReviewBenchmarkReport(legacy, bias),
    "",
    "BUNDLED",
    formatReviewBenchmarkReport(bundled, bias),
    "",
    "PAIRED DELTA",
    `semantic precision: ${delta(bundled.issuePrecision, legacy.issuePrecision)}`,
    `total model characters: ${bundled.totalModelChars - legacy.totalModelChars}`,
    `model calls: ${bundled.totalModelCalls - legacy.totalModelCalls}`,
    `acceptance: ${acceptance.passed ? "PASS" : "FAIL"}`,
    ...acceptance.reasons.map((reason) => `- ${reason}`),
  ].join("\n");
}
