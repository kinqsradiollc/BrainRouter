/**
 * Review service (ADR-008, Wave 2) — a per-workspace port over the latest-review
 * store. Additive and behaviour-preserving: every method delegates to the
 * existing reviewStore functions; `workspaceRoot` is bound at construction. The
 * pure review-model helpers (gate, synthesis, parsing) stay importable as-is.
 */
import {
  getLatestReview, saveReview, clearReview, updateReviewFinding,
} from "./reviewStore.js";
import type { ReviewRun, FindingStatus } from "./reviewModel.js";

/** The latest-review store contract, scoped to one workspace. */
export interface IReviewService {
  getLatest(): ReviewRun | null;
  save(run: ReviewRun): void;
  clear(): void;
  updateFinding(findingId: string, status: FindingStatus, now: string): ReviewRun | null;
}

/** {@link IReviewService} backed by the in-process review store — delegates only. */
export class ReviewService implements IReviewService {
  constructor(private readonly workspaceRoot: string) {}
  getLatest(): ReviewRun | null {
    return getLatestReview(this.workspaceRoot);
  }
  save(run: ReviewRun): void {
    return saveReview(this.workspaceRoot, run);
  }
  clear(): void {
    return clearReview(this.workspaceRoot);
  }
  updateFinding(findingId: string, status: FindingStatus, now: string): ReviewRun | null {
    return updateReviewFinding(this.workspaceRoot, findingId, status, now);
  }
}

/** Construct a review service bound to a workspace. */
export function createReviewService(workspaceRoot: string): IReviewService {
  return new ReviewService(workspaceRoot);
}
