/**
 * ADR-033 D7/§6 — execute the only meaningful review benchmark: a paired
 * legacy-versus-bundled run on one frozen semantic corpus and one provider.
 *
 * There is intentionally no single-arm mode. A lone number cannot prove the
 * ADR's delta claim. Provider configuration is explicit and secret-indirect:
 *
 *   npm run bench:review -w @kinqs/brainrouter-mcp-server -- \
 *     --provider-config=/absolute/path/review-provider.json
 *
 * Provider JSON shape:
 *   {"endpoint":"https://.../v1/chat/completions","model":"...","apiKeyEnv":"NAME"}
 *
 * Missing configuration, a provider error, malformed model output, unavailable
 * frozen revision, or either arm failing exits non-zero. A completed run writes
 * one machine-readable artifact containing corpus/model revisions, both arms,
 * full character/call cost, deltas, and the conjunctive acceptance decision.
 * Failed live runs also write an explicitly failed artifact; they never become
 * a zero-finding report.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_REVIEW_LENS, type ReviewLens } from "@kinqs/brainrouter-core/review";
import { ModelLLMRunner } from "../src/memory/llm/modelRunner.js";
import { redactSensitiveMemoryText } from "../src/memory/util/redaction.js";
import {
  assertReviewBenchmarkWorkingTreeClean,
  evaluateReviewBenchmarkAcceptance,
  formatReviewBenchmarkComparison,
  parseReviewBenchmarkDataset,
  scoreReviewCase,
  summarizeReviewBenchmark,
  type ReviewBenchmarkAcceptance,
  type ReviewBenchmarkCaseScore,
  type ReviewBenchmarkDataset,
  type ReviewBenchmarkModelCall,
  type ReviewBenchmarkReport,
} from "../src/reviews/benchmark/reviewBenchmark.js";
import {
  resolveReviewBenchmarkProvider,
  runReviewBenchmarkArm,
  type ResolvedReviewBenchmarkProvider,
  type ReviewBenchmarkArmExecution,
  type ReviewBenchmarkCompletionRequest,
} from "../src/reviews/benchmark/reviewBenchmarkHarness.js";
import { prepareReviewBenchmarkEvidence } from "./review-bench-evidence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DATA_PATH = join(HERE, "data", "review-cases.json");

interface BenchmarkOptions {
  providerConfigPath: string;
  concurrency: number;
  timeoutMs: number;
  outputPath?: string;
}

interface CaseArtifact {
  id: string;
  pr: number;
  sha: string;
  diffSha256: string;
  evidence: Awaited<ReturnType<typeof prepareReviewBenchmarkEvidence>>["evidence"]["provenance"];
  legacy: ReviewBenchmarkArmExecution;
  bundled: ReviewBenchmarkArmExecution;
  scores: { legacy: ReviewBenchmarkCaseScore; bundled: ReviewBenchmarkCaseScore };
}

interface BenchmarkArtifactBase {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  repositoryRevision: string;
  corpus: {
    path: string;
    sha256: string;
    schemaVersion: number;
    generatedAt: string;
    observationCutoff: string;
    selectedCases: number;
    selectedCaseIds: string[];
  };
  provider: {
    endpoint: string;
    model: string;
    wireFormat: string;
    apiKeyEnv: string;
    configSha256: string;
  };
  options: Omit<BenchmarkOptions, "providerConfigPath" | "outputPath"> & {
    lens: string;
    maxOutputTokens: number;
  };
  systemPromptSha256: string;
  workingTree: { clean: boolean; diffSha256?: string };
}

interface CompleteBenchmarkArtifact extends BenchmarkArtifactBase {
  status: "complete";
  completedAt: string;
  cases: CaseArtifact[];
  reports: { legacy: ReviewBenchmarkReport; bundled: ReviewBenchmarkReport };
  deltas: {
    issuePrecision: number;
    linePrecision: number;
    recall: number;
    totalModelChars: number;
    modelCalls: number;
    wallClockMs: number;
  };
  acceptance: ReviewBenchmarkAcceptance;
}

interface FailedBenchmarkArtifact extends BenchmarkArtifactBase {
  status: "failed";
  completedAt: string;
  completedCases: CaseArtifact[];
  modelCalls: ReviewBenchmarkModelCall[];
  failure: { message: string };
}

/** Setup can fail before corpus/provider identity is trustworthy. Even then the
 * command writes a redacted, mode-0600 failure receipt rather than only stderr. */
interface BootstrapFailedBenchmarkArtifact {
  schemaVersion: 1;
  status: "failed";
  phase: "bootstrap";
  runId: string;
  startedAt: string;
  completedAt: string;
  repositoryRevision: string;
  completedCases: [];
  modelCalls: [];
  failure: { message: string };
}

type BenchmarkArtifact = CompleteBenchmarkArtifact | FailedBenchmarkArtifact | BootstrapFailedBenchmarkArtifact;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function boundedInteger(value: string | undefined, fallback: number, label: string, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): BenchmarkOptions {
  if (args.some((arg) => arg === "--arm" || arg.startsWith("--arm="))) {
    throw new Error("Single-arm review benchmarks are not supported; this command always runs legacy and bundled together.");
  }
  if (args.some((arg) => arg === "--cases" || arg.startsWith("--cases="))) {
    throw new Error("Partial-corpus review benchmarks are not supported; acceptance always uses the entire frozen corpus.");
  }
  if (args.some((arg) => arg === "--lens" || arg.startsWith("--lens="))) {
    throw new Error("The frozen review corpus is evaluated with the code-review lens only.");
  }
  const known = ["provider-config", "concurrency", "timeout-ms", "output"];
  const unknown = args.find((arg) => !known.some((name) => arg.startsWith(`--${name}=`)));
  if (unknown) throw new Error(`Unknown review benchmark argument: ${unknown}`);
  const providerConfig = argumentValue(args, "provider-config");
  if (!providerConfig) {
    throw new Error("--provider-config=/absolute/path/review-provider.json is required.");
  }
  if (!isAbsolute(providerConfig)) throw new Error("Provider config path must be absolute.");
  const output = argumentValue(args, "output");
  return {
    providerConfigPath: providerConfig,
    concurrency: boundedInteger(argumentValue(args, "concurrency"), 4, "--concurrency", 40),
    timeoutMs: boundedInteger(argumentValue(args, "timeout-ms"), 120_000, "--timeout-ms", 900_000),
    ...(output ? { outputPath: resolve(output) } : {}),
  };
}

function readDataset(): { raw: string; dataset: ReviewBenchmarkDataset } {
  const raw = readFileSync(DATA_PATH, "utf8");
  return { raw, dataset: parseReviewBenchmarkDataset(JSON.parse(raw)) };
}

function readProvider(options: BenchmarkOptions): { raw: string; provider: ResolvedReviewBenchmarkProvider } {
  const raw = readFileSync(options.providerConfigPath, "utf8");
  return { raw, provider: resolveReviewBenchmarkProvider(JSON.parse(raw)) };
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function diffFor(sha: string): string {
  const diff = git(["show", "--format=", "--no-color", sha]);
  if (!diff.trim()) throw new Error(`Frozen revision ${sha} has an empty diff.`);
  return diff;
}

function artifactPath(options: BenchmarkOptions, runId: string): string {
  return options.outputPath ?? join(HERE, "results", "review", `${runId}.json`);
}

function safeRunId(startedAt: string, repositoryRevision: string): string {
  return `${startedAt.replace(/[:.]/g, "-")}-${repositoryRevision.slice(0, 12)}`;
}

function artifactBase(input: {
  startedAt: string;
  repositoryRevision: string;
  datasetRaw: string;
  dataset: ReviewBenchmarkDataset;
  providerRaw: string;
  provider: ResolvedReviewBenchmarkProvider;
  options: BenchmarkOptions;
  lens: ReviewLens;
}): BenchmarkArtifactBase {
  const runId = safeRunId(input.startedAt, input.repositoryRevision);
  return {
    schemaVersion: 1,
    runId,
    startedAt: input.startedAt,
    repositoryRevision: input.repositoryRevision,
    corpus: {
      path: relative(REPO_ROOT, DATA_PATH),
      sha256: sha256(input.datasetRaw),
      schemaVersion: input.dataset.schemaVersion,
      generatedAt: input.dataset.generatedAt,
      observationCutoff: input.dataset.observationCutoff,
      selectedCases: input.dataset.cases.length,
      selectedCaseIds: input.dataset.cases.map((entry) => entry.id),
    },
    provider: {
      endpoint: input.provider.endpoint,
      model: input.provider.model,
      wireFormat: input.provider.wireFormat ?? "chat-completions",
      apiKeyEnv: input.provider.apiKeyEnv,
      configSha256: sha256(input.providerRaw),
    },
    options: {
      concurrency: input.options.concurrency,
      timeoutMs: input.options.timeoutMs,
      lens: input.lens.id,
      maxOutputTokens: 4_096,
    },
    systemPromptSha256: sha256(input.lens.systemPrompt),
    workingTree: (() => {
      const status = git(["status", "--porcelain", "--untracked-files=normal"]);
      const diff = git(["diff", "--binary", "--no-ext-diff"]);
      return status ? { clean: false, diffSha256: sha256(`${status}\n${diff}`) } : { clean: true };
    })(),
  };
}

function writeArtifact(path: string, artifact: BenchmarkArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function bootstrapOutputPath(args: readonly string[], startedAt: string, repositoryRevision: string): string {
  const requested = argumentValue(args, "output");
  return requested
    ? resolve(requested)
    : join(HERE, "results", "review", `${safeRunId(startedAt, repositoryRevision)}.json`);
}

function safeError(error: unknown): string {
  return redactSensitiveMemoryText(
    (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 4_000),
  );
}

function sanitizeCalls(calls: readonly ReviewBenchmarkModelCall[]): ReviewBenchmarkModelCall[] {
  return calls.map((call) => ({
    ...call,
    ...(call.error ? { error: redactSensitiveMemoryText(call.error) } : {}),
  }));
}

function sanitizeExecution(execution: ReviewBenchmarkArmExecution): ReviewBenchmarkArmExecution {
  return {
    ...execution,
    run: {
      ...execution.run,
      findings: execution.run.findings.map((finding) => ({
        ...finding,
        file: redactSensitiveMemoryText(finding.file),
        severity: redactSensitiveMemoryText(finding.severity),
        summary: redactSensitiveMemoryText(finding.summary),
        ...(finding.details ? { details: redactSensitiveMemoryText(finding.details) } : {}),
        ...(finding.suggestion ? { suggestion: redactSensitiveMemoryText(finding.suggestion) } : {}),
        ...(finding.codeExcerpt ? { codeExcerpt: redactSensitiveMemoryText(finding.codeExcerpt) } : {}),
      })),
      calls: sanitizeCalls(execution.run.calls),
    },
  };
}

function sanitizeEvidence(evidence: CaseArtifact["evidence"]): CaseArtifact["evidence"] {
  return {
    ...evidence,
    source: redactSensitiveMemoryText(evidence.source),
    revision: redactSensitiveMemoryText(evidence.revision),
    limitations: evidence.limitations.map((entry) => redactSensitiveMemoryText(entry)),
  };
}

function comparisonArtifact(
  base: BenchmarkArtifactBase,
  cases: CaseArtifact[],
  legacy: ReviewBenchmarkReport,
  bundled: ReviewBenchmarkReport,
  acceptance: ReviewBenchmarkAcceptance,
): CompleteBenchmarkArtifact {
  return {
    ...base,
    status: "complete",
    completedAt: new Date().toISOString(),
    cases,
    reports: { legacy, bundled },
    deltas: {
      issuePrecision: bundled.issuePrecision - legacy.issuePrecision,
      linePrecision: bundled.linePrecision - legacy.linePrecision,
      recall: bundled.recall - legacy.recall,
      totalModelChars: bundled.totalModelChars - legacy.totalModelChars,
      modelCalls: bundled.totalModelCalls - legacy.totalModelCalls,
      wallClockMs: bundled.totalWallClockMs - legacy.totalWallClockMs,
    },
    acceptance,
  };
}

async function executeCases(input: {
  dataset: ReviewBenchmarkDataset;
  options: BenchmarkOptions;
  lens: ReviewLens;
  runner: ModelLLMRunner;
  observedCalls: ReviewBenchmarkModelCall[];
  artifacts: CaseArtifact[];
}): Promise<void> {
  for (const benchmarkCase of input.dataset.cases) {
    process.stderr.write(`[review-benchmark] ${benchmarkCase.id}: preparing exact-revision evidence\n`);
    const diff = diffFor(benchmarkCase.sha);
    const prepared = await prepareReviewBenchmarkEvidence({
      benchmarkCase,
      diff,
      repositoryRoot: REPO_ROOT,
      lensId: input.lens.id,
    });
    try {
      const complete = (request: ReviewBenchmarkCompletionRequest) => input.runner.run({
        prompt: request.prompt,
        systemPrompt: request.systemPrompt,
        taskId: request.taskId,
        timeoutMs: input.options.timeoutMs,
      });
      const common = {
        benchmarkCase,
        evidence: prepared.evidence,
        lens: input.lens,
        concurrency: input.options.concurrency,
        complete,
        onModelCall: (call: ReviewBenchmarkModelCall) => input.observedCalls.push(call),
      };
      const legacy = await runReviewBenchmarkArm({ ...common, arm: "legacy" });
      const bundled = await runReviewBenchmarkArm({ ...common, arm: "bundled" });
      const scores = {
        legacy: scoreReviewCase(benchmarkCase, legacy.run),
        bundled: scoreReviewCase(benchmarkCase, bundled.run),
      };
      input.artifacts.push({
        id: benchmarkCase.id,
        pr: benchmarkCase.pr,
        sha: benchmarkCase.sha,
        diffSha256: sha256(diff),
        evidence: sanitizeEvidence(prepared.evidence.provenance),
        legacy: sanitizeExecution(legacy),
        bundled: sanitizeExecution(bundled),
        scores,
      });
      process.stderr.write(
        `[review-benchmark] ${benchmarkCase.id}: paired complete `
        + `(legacy ${scores.legacy.truePositives}/${scores.legacy.falsePositives}; `
        + `bundled ${scores.bundled.truePositives}/${scores.bundled.falsePositives})\n`,
      );
    } finally {
      await prepared.cleanup();
    }
  }
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const args = process.argv.slice(2);
  let repositoryRevision = "unavailable";
  try { repositoryRevision = git(["rev-parse", "HEAD"]).trim() || "unavailable"; } catch { /* receipt below records setup failure */ }
  let output = bootstrapOutputPath(args, startedAt, repositoryRevision);
  let base: BenchmarkArtifactBase | undefined;
  const observedCalls: ReviewBenchmarkModelCall[] = [];
  const completedCases: CaseArtifact[] = [];

  try {
    const options = parseOptions(args);
    const { raw: datasetRaw, dataset } = readDataset();
    const { raw: providerRaw, provider } = readProvider(options);
    const lens = CODE_REVIEW_LENS;
    if (repositoryRevision === "unavailable") throw new Error("Repository revision could not be resolved.");
    base = artifactBase({
      startedAt,
      repositoryRevision,
      datasetRaw,
      dataset,
      providerRaw,
      provider,
      options,
      lens,
    });
    output = artifactPath(options, base.runId);
    // ModelLLMRunner intentionally defaults to no timeout for interactive local
    // cognition. A benchmark is different: an unavailable provider must finish
    // as an explicit failed artifact, so pin the requested bound for this process.
    process.env.BRAINROUTER_LLM_TIMEOUT_MS = String(options.timeoutMs);
    process.env.BRAINROUTER_LLM_MAX_TOKENS = "4096";
    const runner = new ModelLLMRunner(provider.model);
    runner.setProviderOverride({
      endpoint: provider.endpoint,
      apiKey: provider.apiKey,
      model: provider.model,
      ...(provider.wireFormat ? { wireFormat: provider.wireFormat } : {}),
    });
    assertReviewBenchmarkWorkingTreeClean(git(["status", "--porcelain", "--untracked-files=normal"]));
    await executeCases({ dataset, options, lens, runner, observedCalls, artifacts: completedCases });
    // A concurrent edit while the provider was running invalidates the same
    // provenance as a dirty start; never stamp such a run complete.
    assertReviewBenchmarkWorkingTreeClean(git(["status", "--porcelain", "--untracked-files=normal"]));
    const legacy = summarizeReviewBenchmark(completedCases.map((entry) => entry.scores.legacy));
    const bundled = summarizeReviewBenchmark(completedCases.map((entry) => entry.scores.bundled));
    const acceptance = evaluateReviewBenchmarkAcceptance(legacy, bundled);
    writeArtifact(output, comparisonArtifact(base, completedCases, legacy, bundled, acceptance));
    process.stdout.write(`${formatReviewBenchmarkComparison(legacy, bundled, acceptance, dataset.groundTruthBias)}\n`);
    process.stdout.write(`artifact: ${output}\n`);
    return acceptance.passed ? 0 : 2;
  } catch (error) {
    const message = safeError(error);
    writeArtifact(output, base
      ? {
        ...base,
        status: "failed",
        completedAt: new Date().toISOString(),
        completedCases,
        modelCalls: sanitizeCalls(observedCalls),
        failure: { message },
      }
      : {
        schemaVersion: 1,
        status: "failed",
        phase: "bootstrap",
        runId: safeRunId(startedAt, repositoryRevision),
        startedAt,
        completedAt: new Date().toISOString(),
        repositoryRevision,
        completedCases: [],
        modelCalls: [],
        failure: { message },
      });
    process.stderr.write(`[review-benchmark] FAILED: ${message}\n`);
    process.stderr.write(`[review-benchmark] failed artifact: ${output}\n`);
    return 1;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`[review-benchmark] configuration failed: ${safeError(error)}\n`);
    process.exitCode = 1;
  },
);
