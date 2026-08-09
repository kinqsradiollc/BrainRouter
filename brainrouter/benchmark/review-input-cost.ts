/**
 * ADR-033 D7 diagnostic — measure production-evidence prompt input without a provider.
 *
 * This always runs both arms over the complete frozen corpus with valid empty
 * mock completions. It is useful for locating deterministic prompt-cost growth,
 * but it cannot establish semantic precision, completion cost, or §6 acceptance.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_REVIEW_LENS } from "@kinqs/brainrouter-core/review";
import {
  parseReviewBenchmarkDataset,
  type ReviewBenchmarkPromptCostBreakdown,
} from "../src/reviews/benchmark/reviewBenchmark.js";
import {
  planReviewBenchmarkBundles,
  runReviewBenchmarkArm,
  type ReviewBenchmarkArmExecution,
} from "../src/reviews/benchmark/reviewBenchmarkHarness.js";
import { prepareReviewBenchmarkEvidence } from "./review-bench-evidence.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HERE, "..", "..");
const DATA_PATH = join(HERE, "data", "review-cases.json");
const EMPTY_FINDINGS_REPLY = "```json\n[]\n```";

interface InputCost {
  calls: number;
  systemChars: number;
  promptChars: number;
  inputChars: number;
  promptBreakdown: ReviewBenchmarkPromptCostBreakdown;
}

interface InputCostRowArm extends InputCost {
  reviewedUnits: number;
}

interface InputCostRow {
  id: string;
  legacy: InputCostRowArm;
  bundled: InputCostRowArm & {
    units: Array<{
      id: string;
      paths: string[];
      relations: string[];
      diffChars: number;
      repositoryContextChars: number;
    }>;
  };
  delta: { calls: number; inputChars: number };
}

const EMPTY_BREAKDOWN: ReviewBenchmarkPromptCostBreakdown = {
  framingChars: 0,
  diffEvidenceChars: 0,
  repositoryContextChars: 0,
  servedEvidenceChars: 0,
  contractChars: 0,
  evidenceRequestChars: 0,
  reflectionEvidenceChars: 0,
  continuationChars: 0,
};

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function addBreakdown(
  left: ReviewBenchmarkPromptCostBreakdown,
  right: ReviewBenchmarkPromptCostBreakdown,
): ReviewBenchmarkPromptCostBreakdown {
  return {
    framingChars: left.framingChars + right.framingChars,
    diffEvidenceChars: left.diffEvidenceChars + right.diffEvidenceChars,
    repositoryContextChars: left.repositoryContextChars + right.repositoryContextChars,
    servedEvidenceChars: left.servedEvidenceChars + right.servedEvidenceChars,
    contractChars: left.contractChars + right.contractChars,
    evidenceRequestChars: left.evidenceRequestChars + right.evidenceRequestChars,
    reflectionEvidenceChars: left.reflectionEvidenceChars + right.reflectionEvidenceChars,
    continuationChars: left.continuationChars + right.continuationChars,
  };
}

function inputCost(execution: ReviewBenchmarkArmExecution): InputCost {
  const promptBreakdown = execution.run.calls.reduce<ReviewBenchmarkPromptCostBreakdown>(
    (sum, call) => addBreakdown(sum, call.promptBreakdown),
    { ...EMPTY_BREAKDOWN },
  );
  const systemChars = execution.run.calls.reduce((sum, call) => sum + call.systemChars, 0);
  const promptChars = execution.run.calls.reduce((sum, call) => sum + call.promptChars, 0);
  return {
    calls: execution.run.calls.length,
    systemChars,
    promptChars,
    inputChars: systemChars + promptChars,
    promptBreakdown,
  };
}

function addCost(left: InputCost, right: InputCost): InputCost {
  return {
    calls: left.calls + right.calls,
    systemChars: left.systemChars + right.systemChars,
    promptChars: left.promptChars + right.promptChars,
    inputChars: left.inputChars + right.inputChars,
    promptBreakdown: addBreakdown(left.promptBreakdown, right.promptBreakdown),
  };
}

async function main(): Promise<void> {
  const dataset = parseReviewBenchmarkDataset(JSON.parse(readFileSync(DATA_PATH, "utf8")));
  const rows: InputCostRow[] = [];
  for (const benchmarkCase of dataset.cases) {
    process.stderr.write(`[review-input-cost] ${benchmarkCase.id}: preparing exact-revision evidence\n`);
    const diff = git(["show", "--format=", "--no-color", benchmarkCase.sha]);
    const prepared = await prepareReviewBenchmarkEvidence({
      benchmarkCase,
      diff,
      repositoryRoot: REPOSITORY_ROOT,
      lensId: CODE_REVIEW_LENS.id,
    });
    try {
      const common = {
        benchmarkCase,
        evidence: prepared.evidence,
        lens: CODE_REVIEW_LENS,
        concurrency: 4,
        complete: async () => EMPTY_FINDINGS_REPLY,
      };
      const legacyExecution = await runReviewBenchmarkArm({ ...common, arm: "legacy" });
      const bundledExecution = await runReviewBenchmarkArm({ ...common, arm: "bundled" });
      const legacy = {
        ...inputCost(legacyExecution),
        reviewedUnits: legacyExecution.reviewedUnits,
      };
      const plan = planReviewBenchmarkBundles(prepared.evidence);
      const bundled = {
        ...inputCost(bundledExecution),
        reviewedUnits: bundledExecution.reviewedUnits,
        units: plan.bundles.map((bundle) => ({
          id: bundle.id,
          paths: [...bundle.paths],
          relations: [...bundle.relations],
          diffChars: bundle.diff.length,
          repositoryContextChars: bundledExecution.run.calls
            .filter((call) => call.phase === `bundle-${bundle.id}` || call.phase === `bundle-${bundle.id}-evidence`)
            .reduce((sum, call) => sum + call.promptBreakdown.repositoryContextChars, 0),
        })),
      };
      rows.push({
        id: benchmarkCase.id,
        legacy,
        bundled,
        delta: { calls: bundled.calls - legacy.calls, inputChars: bundled.inputChars - legacy.inputChars },
      });
    } finally {
      await prepared.cleanup();
    }
  }

  const zero: InputCost = { calls: 0, systemChars: 0, promptChars: 0, inputChars: 0, promptBreakdown: { ...EMPTY_BREAKDOWN } };
  const legacy = rows.reduce((sum, row) => addCost(sum, row.legacy), zero);
  const bundled = rows.reduce((sum, row) => addCost(sum, row.bundled), zero);
  process.stdout.write(`${JSON.stringify({
    kind: "non-qualifying-model-independent-input-diagnostic",
    qualifyingSection6Evidence: false,
    repositoryRevision: git(["rev-parse", "HEAD"]).trim(),
    workingTreeDirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"]).trim()),
    corpusCases: rows.length,
    rows,
    totals: {
      legacy,
      bundled,
      delta: { calls: bundled.calls - legacy.calls, inputChars: bundled.inputChars - legacy.inputChars },
    },
  }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`[review-input-cost] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
