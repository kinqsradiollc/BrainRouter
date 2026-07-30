import {
  projectReviewAssuranceDetailView,
  type ReviewAssuranceDetailView,
  type ReviewSummaryView,
} from '@kinqs/brainrouter-core/review';
import {
  accountApiRequest,
  type AccountApiTarget,
} from '../../runtime/account/accountClient.js';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reviewSummary(value: unknown): ReviewSummaryView | null {
  const row = record(value);
  if (
    typeof row.id !== 'string'
    || !row.id.trim()
    || !['security', 'code', 'pentest'].includes(String(row.lens))
    || typeof row.status !== 'string'
    || !row.status.trim()
  ) return null;
  return {
    id: row.id,
    lens: row.lens as ReviewSummaryView['lens'],
    status: row.status,
    repo: typeof row.repo === 'string' ? row.repo : null,
    prNumber: Number.isSafeInteger(row.prNumber) && Number(row.prNumber) > 0 ? Number(row.prNumber) : null,
    ...(row.forge === 'github' || row.forge === 'gitlab' ? { forge: row.forge } : {}),
    findings: Number.isSafeInteger(row.findings) && Number(row.findings) >= 0 ? Number(row.findings) : null,
    blocking: Number.isSafeInteger(row.blocking) && Number(row.blocking) >= 0 ? Number(row.blocking) : null,
    skipped: typeof row.skipped === 'string' ? row.skipped : null,
    error: typeof row.error === 'string' ? row.error : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
  };
}

export async function listAccountReviewJobs(
  target: AccountApiTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reviews: ReviewSummaryView[]; canRun: boolean }> {
  const body = await accountApiRequest<unknown>(
    target,
    'GET',
    '/api/admin/reviews/jobs?limit=30',
    undefined,
    fetchImpl,
  );
  const response = record(body);
  const reviews = Array.isArray(response.reviews)
    ? response.reviews.map(reviewSummary).filter((row): row is ReviewSummaryView => row !== null)
    : [];
  return { reviews, canRun: response.canRun === true };
}

export async function getAccountReviewAssurance(
  target: AccountApiTarget,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReviewAssuranceDetailView> {
  const body = await accountApiRequest<unknown>(
    target,
    'GET',
    `/api/admin/reviews/jobs/${encodeURIComponent(jobId)}`,
    undefined,
    fetchImpl,
  );
  const detail = projectReviewAssuranceDetailView(body);
  if (!detail) throw new Error('The review service returned an invalid assurance detail.');
  return detail;
}
