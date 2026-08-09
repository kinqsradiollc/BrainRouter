/**
 * ADR-033 D7 — run the reviewer over our own merged pull requests and report
 * precision, recall, position accuracy, wall clock and cost.
 *
 * Everything is local: the case's diff comes from `git show <sha>` (our PRs are
 * squash-merged, so one commit is one pull request), the served files come from
 * the same checkout at the same revision, and the reviewer is the SAME core
 * orchestration the bot runs — bundles, concurrency, computed positions, the
 * one file request, reflection. The forge is not involved, so this can be run
 * against any checkout of the repository.
 *
 *   npx tsx benchmark/review-bench.ts [--cases=8] [--concurrency=4]
 *                                     [--lens=security|code] [--arm=bundled|legacy]
 *
 * ## Why there are two arms
 *
 * "Precision goes up and tokens go down" is a DELTA claim, and a delta needs two
 * measurements. `--arm=legacy` is the reviewer as it was before ADR-033: one
 * size-split chunk per model call, run serially, findings positioned by whatever
 * line the model remembered, no reflection pass. `--arm=bundled` is what ships.
 * Run both on the same frozen set and the difference is the evidence; run one
 * and you have a number with nothing to compare it to, which is how this file
 * started life.
 *
 * Read the output with its bias statement attached; see `reviewBenchmark.ts`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildEvidenceRequestContract,
  CODE_REVIEW_LENS,
  dedupeReviewFindings,
  formatServedEvidence,
  orchestrateReview,
  parseEvidenceRequest,
  parseReviewFindings,
  planReviewBundles,
  reflectOnReviewFindings,
  relatedPathsFromDiff,
  SECURITY_LENS,
  stripReasoning,
  type ParsedReviewFinding,
} from "@kinqs/brainrouter-core/review";
import { splitDiffForReview } from "../src/integrations/reviewDiffChunks.js";
import { ModelLLMRunner } from "../src/memory/llm/modelRunner.js";
import { createReviewFileAccess } from "../src/reviews/reviewFileAccess.js";
import {
  formatReviewBenchmarkReport,
  scoreReviewCase,
  summarizeReviewBenchmark,
  type ReviewBenchmarkCase,
  type ReviewBenchmarkCaseScore,
  type ReviewBenchmarkDataset,
} from "../src/reviews/benchmark/reviewBenchmark.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DATA = join(HERE, "data", "review-cases.json");
/** The production cap (`prSecurityReview.ts` `maxDiffChars`), so the units match. */
const MAX_BUNDLE_CHARS = 60_000;

function argOf(name: string, fallback: string): string {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
}

/**
 * Serve a file from the reviewed revision, through the SAME access boundary the
 * bot uses. `git show <sha>:<path>` is this harness's checkout: the revision is
 * pinned, so a file that moved after the merge cannot be substituted for the one
 * the reviewer asked about.
 */
function checkoutReaderFor(sha: string) {
  return {
    async readSourceFile(path: string, maxBytes: number): Promise<string> {
      const content = execFileSync("git", ["show", `${sha}:${path}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (content.length > maxBytes) throw new Error("Requested source path exceeds the read limit.");
      return content;
    },
  };
}

interface ArmCost {
  promptChars: number;
  completionChars: number;
  modelCalls: number;
}

type RunModel = (prompt: string) => Promise<string>;

/** The reviewer that ships: bundles, concurrency, one file request, reflection. */
async function runBundledArm(
  benchmarkCase: ReviewBenchmarkCase,
  diff: string,
  lens: typeof CODE_REVIEW_LENS,
  concurrency: number,
  run: RunModel,
): Promise<ParsedReviewFinding[]> {
  const plan = planReviewBundles({
    diff,
    maxBundleChars: MAX_BUNDLE_CHARS,
    maxBundles: 40,
    relatedPaths: relatedPathsFromDiff(diff),
  });
  const access = createReviewFileAccess(checkoutReaderFor(benchmarkCase.sha));
  // `repositoryContext` is FALSE and that is not an oversight: this harness has
  // no packet assembler, so telling the model it was handed one would benchmark
  // a prompt the bot never sends. `canRequestFiles` is true because the seam
  // above genuinely serves — D3 is exercised, the packet claim is not faked.
  const contract = lens.buildContract({ repositoryContext: false, canRequestFiles: true });
  const result = await orchestrateReview({
    diff,
    bundles: plan.bundles,
    concurrency,
    analyzeBundle: async (bundle) => {
      const head = `You are reviewing pull request #${benchmarkCase.pr}. `
        + `This unit covers: ${bundle.paths.join(", ")}.\n\n`
        + `<untrusted_diff_evidence>\n${bundle.diff}\n</untrusted_diff_evidence>\n\n`;
      try {
        const first = stripReasoning(await run(`${head}${contract}\n\n${buildEvidenceRequestContract()}`));
        const requested = parseEvidenceRequest(first);
        if (!requested) return { bundleId: bundle.id, ok: true, findings: parseReviewFindings(first) };
        const served = await access.serve(requested);
        const second = stripReasoning(await run(
          `${head}<untrusted_repository_context>\n${formatServedEvidence(served)}\n`
          + `</untrusted_repository_context>\n\n${contract}\n\n`
          + `You already used your one file request; report your findings now.`,
        ));
        return { bundleId: bundle.id, ok: true, findings: parseReviewFindings(second) };
      } catch (error) {
        return { bundleId: bundle.id, ok: false, findings: [], error: error instanceof Error ? error.message : "failed" };
      }
    },
    reflect: (findings) => reflectOnReviewFindings(findings, {
      complete: (request) => run(`${request.system}\n\n${request.user}`),
    }),
  });
  return result.findings;
}

/**
 * The reviewer as it was BEFORE this ADR — the baseline the delta is measured
 * against. Size-split chunks, one after another, the model's own line numbers
 * published unchecked, and no pass that reads the findings as a set.
 */
async function runLegacyArm(
  benchmarkCase: ReviewBenchmarkCase,
  diff: string,
  lens: typeof CODE_REVIEW_LENS,
  run: RunModel,
): Promise<ParsedReviewFinding[]> {
  const contract = lens.buildContract({ repositoryContext: false, canRequestFiles: false });
  const parts = splitDiffForReview(diff, MAX_BUNDLE_CHARS);
  const findings: ParsedReviewFinding[] = [];
  for (let index = 0; index < parts.length; index++) {
    const label = parts.length > 1 ? ` (part ${index + 1} of ${parts.length})` : "";
    try {
      const reply = stripReasoning(await run(
        `You are reviewing pull request #${benchmarkCase.pr}${label}.\n\n`
        + `<untrusted_diff_evidence>\n${parts[index]}\n</untrusted_diff_evidence>\n\n${contract}`,
      ));
      findings.push(...parseReviewFindings(reply));
    } catch {
      // D8's predecessor behaviour: a failed part costs its coverage, not the run.
    }
  }
  return dedupeReviewFindings(findings);
}

async function main(): Promise<void> {
  const dataset = JSON.parse(readFileSync(DATA, "utf8")) as ReviewBenchmarkDataset;
  const limit = Number(argOf("cases", "8"));
  const concurrency = Number(argOf("concurrency", "4"));
  const lens = argOf("lens", "code") === "security" ? SECURITY_LENS : CODE_REVIEW_LENS;
  const arm = argOf("arm", "bundled") === "legacy" ? "legacy" : "bundled";
  const runner = new ModelLLMRunner();
  const scores: ReviewBenchmarkCaseScore[] = [];

  for (const benchmarkCase of dataset.cases.slice(0, limit)) {
    let diff = "";
    try {
      diff = execFileSync("git", ["show", "--format=", "--no-color", benchmarkCase.sha], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
      });
    } catch {
      process.stdout.write(`skip ${benchmarkCase.id}: commit not in this checkout\n`);
      continue;
    }
    const cost: ArmCost = { promptChars: 0, completionChars: 0, modelCalls: 0 };
    const run: RunModel = async (prompt) => {
      cost.promptChars += prompt.length;
      cost.modelCalls += 1;
      const reply = await runner.run({
        prompt,
        systemPrompt: lens.systemPrompt,
        taskId: `bench:${arm}:${benchmarkCase.id}`,
        timeoutMs: 120_000,
      });
      cost.completionChars += reply.length;
      return reply;
    };
    const startedAt = Date.now();
    const findings = arm === "legacy"
      ? await runLegacyArm(benchmarkCase, diff, lens, run)
      : await runBundledArm(benchmarkCase, diff, lens, concurrency, run);
    const score = scoreReviewCase(benchmarkCase, {
      caseId: benchmarkCase.id,
      findings: findings.map((finding) => ({
        file: finding.file,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        severity: finding.severity,
        summary: finding.summary,
      })),
      wallClockMs: Date.now() - startedAt,
      promptChars: cost.promptChars,
      completionChars: cost.completionChars,
      modelCalls: cost.modelCalls,
    });
    scores.push(score);
    process.stdout.write(
      `${benchmarkCase.id}: ${score.truePositives} hit / ${score.falsePositives} false / ${score.missed} missed`
      + ` · ${score.onTheRightLine} on the right line · ${score.modelCalls} calls · ${(score.wallClockMs / 1000).toFixed(1)}s\n`,
    );
  }

  process.stdout.write(
    `\narm: ${arm}\n${formatReviewBenchmarkReport(summarizeReviewBenchmark(scores), dataset.groundTruthBias)}\n`,
  );
}

void main();
