/**
 * ADR-033 D1/D2 — the review pipeline, once, with its inputs injected.
 *
 * One orchestration: plan bundles of related files, review them CONCURRENTLY
 * (they are independent by construction, which is the whole point of bundling),
 * compute each finding's position from evidence, and reflect over the set
 * before anything is published. What differs between surfaces is the front door
 * — a pull-request diff posting comments, or a working tree printing to a
 * terminal — and the sinks, not the pipeline.
 *
 * The model-facing work is a single injected seam (`analyzeBundle`), so this
 * module is exercised end-to-end in tests with no network, and a surface that
 * adopts it cannot accidentally get a different pipeline than the bot's.
 *
 * Failure is per-bundle on purpose (ADR-033 D8): one bundle that cannot be
 * reviewed leaves the others' findings intact and is reported as missing
 * coverage, rather than sinking the run and wedging a required check.
 */
import { positionReviewFindings, type FindingPositionKind } from './findingPosition.js';
import { dedupeReviewFindings, type ParsedReviewFinding } from './reviewFindings.js';
import type { ReviewBundle } from './reviewBundles.js';
import type { ReviewReflectionResult } from './reviewReflection.js';

export interface ReviewBundleOutcome {
  bundleId: string;
  findings: ParsedReviewFinding[];
  ok: boolean;
  error?: string;
  /** Paths the reviewer asked for and was served this round (D3). */
  requestedFiles?: string[];
}

export interface ReviewOrchestrationInput {
  /** The full diff — positions are computed against it, not against a bundle. */
  diff: string;
  bundles: readonly ReviewBundle[];
  /** How many bundles may be in flight at once. */
  concurrency: number;
  analyzeBundle(
    bundle: ReviewBundle,
    context: { index: number; total: number },
  ): Promise<ReviewBundleOutcome>;
  reflect?(findings: readonly ParsedReviewFinding[]): Promise<ReviewReflectionResult>;
  isCancellationRequested?(): boolean | Promise<boolean>;
  onBundleSettled?(outcome: ReviewBundleOutcome): void;
}

export interface ReviewOrchestrationResult {
  findings: ParsedReviewFinding[];
  outcomes: ReviewBundleOutcome[];
  reviewedBundles: number;
  failedBundles: number;
  /** Bundles never dispatched because the run was canceled mid-flight. */
  skippedBundles: number;
  canceled: boolean;
  reflection: { reflected: boolean; dropped: number; merged: number };
  /** How the published lines were established — the D4 evidence, counted. */
  positions: Record<FindingPositionKind, number>;
}

const EMPTY_POSITIONS: Record<FindingPositionKind, number> = {
  excerpt_match: 0,
  excerpt_relocated: 0,
  model_line_confirmed: 0,
  file_only: 0,
  path_unknown: 0,
};

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R | null>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  const width = Math.max(1, Math.min(Math.trunc(limit) || 1, items.length));
  let cursor = 0;
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function orchestrateReview(
  input: ReviewOrchestrationInput,
): Promise<ReviewOrchestrationResult> {
  const bundles = [...input.bundles];
  let canceled = false;
  const canceledNow = async (): Promise<boolean> => {
    if (canceled) return true;
    canceled = Boolean(await input.isCancellationRequested?.());
    return canceled;
  };

  const settled = await mapWithConcurrency(bundles, input.concurrency, async (bundle, index) => {
    if (await canceledNow()) return null;
    let outcome: ReviewBundleOutcome;
    try {
      outcome = await input.analyzeBundle(bundle, { index, total: bundles.length });
    } catch (error) {
      outcome = {
        bundleId: bundle.id,
        findings: [],
        ok: false,
        error: error instanceof Error ? error.message : 'bundle review failed',
      };
    }
    input.onBundleSettled?.(outcome);
    return outcome;
  });

  const outcomes = settled.filter((entry): entry is ReviewBundleOutcome => entry !== null);
  const collected = outcomes.flatMap((outcome) => outcome.findings);
  const positioned = positionReviewFindings(collected, input.diff);
  const positions = { ...EMPTY_POSITIONS };
  for (const entry of positioned) positions[entry.position.kind] += 1;
  const deduped = dedupeReviewFindings(positioned.map((entry) => entry.finding));

  let findings = deduped;
  let reflection = { reflected: false, dropped: 0, merged: 0 };
  if (input.reflect && deduped.length > 0 && !canceled) {
    const result = await input.reflect(deduped);
    findings = result.findings;
    reflection = { reflected: result.reflected, dropped: result.dropped, merged: result.merged };
  }

  return {
    findings,
    outcomes,
    reviewedBundles: outcomes.filter((outcome) => outcome.ok).length,
    failedBundles: outcomes.filter((outcome) => !outcome.ok).length,
    skippedBundles: bundles.length - outcomes.length,
    canceled,
    reflection,
    positions,
  };
}
