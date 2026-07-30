import type {
  AssuranceFindingView,
  ReviewAssuranceDetailView,
  ReviewSummaryView,
} from './assuranceDetailContracts.js';
import {
  nonEmpty,
  nullableNonNegativeInteger,
  oneOf,
  projectFinding,
  projectPublication,
  record,
} from './assuranceDetailValidation.js';
import { projectAssuranceRun } from './assuranceRunProjector.js';

function projectReview(value: unknown): ReviewSummaryView | null {
  const review = record(value);
  if (
    !review
    || !nonEmpty(review.id)
    || !oneOf(review.lens, ['security', 'code', 'pentest'])
    || !nonEmpty(review.status)
    || !(review.repo === null || nonEmpty(review.repo))
    || !nullableNonNegativeInteger(review.prNumber)
    || (typeof review.prNumber === 'number' && review.prNumber === 0)
    || !(review.forge === undefined || oneOf(review.forge, ['github', 'gitlab']))
    || !nullableNonNegativeInteger(review.findings)
    || !nullableNonNegativeInteger(review.blocking)
    || !(review.skipped === null || nonEmpty(review.skipped))
    || !(review.error === null || nonEmpty(review.error))
    || !nonEmpty(review.updatedAt)
    || !nonEmpty(review.createdAt)
  ) return null;
  return {
    id: review.id,
    lens: review.lens,
    status: review.status,
    repo: review.repo,
    prNumber: review.prNumber,
    ...(review.forge === undefined ? {} : { forge: review.forge }),
    findings: review.findings,
    blocking: review.blocking,
    skipped: review.skipped,
    error: review.error,
    updatedAt: review.updatedAt,
    createdAt: review.createdAt,
  };
}

/**
 * Adapt the account API's durable review-detail response into the stable host
 * protocol. This is structural validation only: lifecycle and publication
 * policy remain owned by the assurance domain and backend.
 */
export function projectReviewAssuranceDetailView(value: unknown): ReviewAssuranceDetailView | null {
  const detail = record(value);
  if (!detail || typeof detail.canRun !== 'boolean') return null;
  const review = projectReview(detail.review);
  if (!review) return null;
  if (detail.assurance === null) {
    return { review, assurance: null, canRun: detail.canRun };
  }
  const assurance = record(detail.assurance);
  if (!assurance || !Array.isArray(assurance.findings)) return null;
  const run = projectAssuranceRun(assurance.run);
  const findings = assurance.findings.map(projectFinding);
  const publication = assurance.publication === undefined
    ? undefined
    : projectPublication(assurance.publication);
  if (
    !run
    || findings.some((finding) => finding === null)
    || publication === null
  ) return null;
  return {
    review,
    assurance: {
      run,
      findings: findings as AssuranceFindingView[],
      ...(publication === undefined ? {} : { publication }),
    },
    canRun: detail.canRun,
  };
}
