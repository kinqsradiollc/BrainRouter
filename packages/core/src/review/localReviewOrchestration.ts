/**
 * ADR-033 D1 — the local front door for the shared review orchestration.
 *
 * Desktop and CLI both have a real Agent over a working tree, while the PR bot
 * has a bounded checkout-file request protocol. That transport difference is
 * injected here as `createTurn`; bundle planning, concurrency, parsing,
 * evidence-derived positioning, de-duplication, and reflection remain the same
 * core pipeline the bot uses.
 */
import {
  parseReviewFindingsEnvelope,
  type ParsedReviewFinding,
} from './reviewFindings.js';
import {
  planReviewBundles,
  relatedPathsFromDiff,
  type ReviewBundle,
  type ReviewBundlePlan,
} from './reviewBundles.js';
import {
  orchestrateReview,
  type ReviewBundleOutcome,
  type ReviewOrchestrationResult,
} from './reviewOrchestration.js';
import { reflectOnReviewFindings } from './reviewReflection.js';
import { buildWorkingTreeReviewPrompt } from './workingTreeReview.js';
import { prepareReviewDiffSource, type PreparedReviewDiffSource } from './sourceSafety.js';

export interface LocalReviewTurn {
  run(prompt: string): Promise<string>;
  interrupt?(): void;
}

export type LocalReviewTurnContext = (
  | {
    phase: 'bundle';
    bundle: ReviewBundle;
    index: number;
    total: number;
  }
  | {
    phase: 'reflection';
    /** Must be installed as the Agent's system prompt, not treated as evidence. */
    systemPrompt: string;
    totalFindings: number;
  }) & {
    /** Strict LLM invocation ceiling the created Agent must enforce. */
    modelCallLimit: number;
    /** Shared absolute review deadline, in epoch milliseconds. */
    deadlineMs: number;
  };

export interface LocalReviewOrchestrationInput {
  diff: string;
  reviewInstructions?: string;
  changeContext?: string;
  relatedPaths?: ReadonlyArray<readonly [string, string]>;
  maxBundleChars?: number;
  maxBundles?: number;
  concurrency: number;
  executionBudget?: {
    maxModelCalls: number;
    maxDurationMs: number;
    maxModelCallsPerBundle: number;
  };
  createTurn(context: LocalReviewTurnContext): LocalReviewTurn;
  /** Bounded, source-safe working-tree reader used only for D4 positioning. */
  sourceTextForPath?(path: string): string | null | Promise<string | null>;
  isCancellationRequested?(): boolean | Promise<boolean>;
  onBundleSettled?(outcome: ReviewBundleOutcome): void;
}

export interface LocalReviewOrchestrationResult {
  plan: ReviewBundlePlan;
  review: ReviewOrchestrationResult;
  source: PreparedReviewDiffSource;
  /** Raw replies are diagnostic/provenance only; callers publish `review`. */
  replies: Record<string, string>;
}

/**
 * Parse the required review envelope strictly enough that malformed model
 * output cannot be mistaken for a clean review. An explicit fenced `[]` is a
 * valid no-findings answer; missing/invalid/dropped entries are unavailable
 * coverage and become a failed bundle outcome.
 */
export function parseLocalReviewReply(raw: string):
  | { ok: true; findings: ParsedReviewFinding[] }
  | { ok: false; error: string } {
  return parseReviewFindingsEnvelope(raw);
}

export async function runLocalReviewOrchestration(
  input: LocalReviewOrchestrationInput,
): Promise<LocalReviewOrchestrationResult> {
  const budget = input.executionBudget ?? {
    maxModelCalls: 40,
    maxDurationMs: 10 * 60_000,
    maxModelCallsPerBundle: 2,
  };
  if (
    !Number.isSafeInteger(budget.maxModelCalls)
    || budget.maxModelCalls < 2
    || !Number.isSafeInteger(budget.maxDurationMs)
    || budget.maxDurationMs < 1
    || !Number.isSafeInteger(budget.maxModelCallsPerBundle)
    || budget.maxModelCallsPerBundle < 1
    || budget.maxModelCallsPerBundle > budget.maxModelCalls - 1
  ) {
    throw new Error(
      'local review execution budget must reserve one reflection call and use positive, bounded integer limits',
    );
  }
  const deadlineMs = Date.now() + budget.maxDurationMs;
  const budgetBundleCap = Math.floor(
    (budget.maxModelCalls - 1) / budget.maxModelCallsPerBundle,
  );
  const source = prepareReviewDiffSource(input.diff);
  const planned = planReviewBundles({
    diff: source.diff,
    maxBundleChars: input.maxBundleChars ?? 18_000,
    maxBundles: Math.min(input.maxBundles ?? 40, budgetBundleCap),
    relatedPaths: [
      ...(input.relatedPaths ?? []).map(([left, right]) => [left, right] as [string, string]),
      ...relatedPathsFromDiff(source.diff),
    ],
  });
  const plan: ReviewBundlePlan = {
    ...planned,
    deferredPaths: [...new Set([...planned.deferredPaths, ...source.excludedPaths])].sort(),
    totalFiles: source.totalFiles,
  };
  if (
    source.diff.trim()
    && (planned.totalFiles === 0 || plan.bundles.some((bundle) => bundle.paths.length === 0))
  ) {
    throw new Error('review diff could not be partitioned into file-backed review bundles');
  }
  const replies: Record<string, string> = {};
  const runWithinDeadline = async (turn: LocalReviewTurn, prompt: string): Promise<string> => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error('local review duration budget was exhausted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        turn.run(prompt),
        new Promise<string>((_resolve, reject) => {
          timer = setTimeout(() => {
            turn.interrupt?.();
            reject(new Error('local review duration budget was exhausted'));
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const review = await orchestrateReview({
    diff: source.diff,
    bundles: plan.bundles,
    concurrency: input.concurrency,
    isCancellationRequested: input.isCancellationRequested,
    sourceTextForPath: input.sourceTextForPath,
    onBundleSettled: input.onBundleSettled,
    analyzeBundle: async (bundle, context) => {
      const turn = input.createTurn({
        phase: 'bundle',
        bundle,
        ...context,
        modelCallLimit: budget.maxModelCallsPerBundle,
        deadlineMs,
      });
      const reply = await runWithinDeadline(turn, buildWorkingTreeReviewPrompt({
        reviewInstructions: input.reviewInstructions,
        changeContext: [
          `Review unit ${context.index + 1}/${context.total}: ${bundle.paths.join(', ') || bundle.id}.`,
          input.changeContext ?? '',
        ].filter(Boolean).join('\n\n'),
        diff: bundle.diff,
      }));
      replies[bundle.id] = reply;
      const parsed = parseLocalReviewReply(reply);
      return parsed.ok
        ? { bundleId: bundle.id, findings: parsed.findings, ok: true }
        : { bundleId: bundle.id, findings: [], ok: false, error: parsed.error };
    },
    reflect: async (findings) => reflectOnReviewFindings(findings, {
      complete: async ({ system, user }) => {
        const turn = input.createTurn({
          phase: 'reflection',
          systemPrompt: system,
          totalFindings: findings.length,
          modelCallLimit: 1,
          deadlineMs,
        });
        const reply = await runWithinDeadline(turn, user);
        replies.reflection = reply;
        return reply;
      },
    }),
  });

  return { plan, review, source, replies };
}
