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
import {
  buildDiffLineIndex,
  positionReviewFindings,
  resolveFindingPath,
  type FindingPositionKind,
} from './findingPosition.js';
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
  /** Exact new-revision source for D4; null keeps the safe diff-only fallback. */
  sourceTextForPath?(path: string): string | null | Promise<string | null>;
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
  reflection: {
    /** True when at least one surviving candidate required the D5 set pass. */
    required: boolean;
    /** True only when the pass successfully judged the entire candidate set. */
    reflected: boolean;
    dropped: number;
    merged: number;
  };
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
  const exactSources = new Map<string, string>();
  if (input.sourceTextForPath && collected.length > 0) {
    const diffIndex = buildDiffLineIndex(input.diff);
    const paths = [...new Set(collected
      .map((finding) => resolveFindingPath(finding.file, diffIndex))
      .filter((path): path is string => Boolean(path)))];
    await Promise.all(paths.map(async (path) => {
      try {
        const source = await input.sourceTextForPath?.(path);
        if (typeof source === 'string') exactSources.set(path, source);
      } catch {
        // Exact source is an evidence upgrade. Failure falls back to diff lines.
      }
    }));
  }
  const positioned = positionReviewFindings(collected, input.diff, exactSources);
  const positions = { ...EMPTY_POSITIONS };
  for (const entry of positioned) positions[entry.position.kind] += 1;
  const deduped = dedupeReviewFindings(positioned.map((entry) => entry.finding));

  let findings = deduped;
  let reflection = { required: deduped.length > 0, reflected: false, dropped: 0, merged: 0 };
  if (input.reflect && reflection.required && !canceled) {
    try {
      const result = await input.reflect(deduped);
      findings = result.findings;
      reflection = {
        required: true,
        reflected: result.reflected,
        dropped: result.dropped,
        merged: result.merged,
      };
    } catch {
      // Preserve every evidence-positioned finding, but leave `reflected=false`
      // so each publication surface reports incomplete D5 coverage.
    }
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
