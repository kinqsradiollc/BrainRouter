import {
  projectReviewAssuranceDetailView,
  type ReviewAssuranceDetailView,
} from '@kinqs/brainrouter-agent-protocol';
import {
  brainRouterAccountHeaders,
  timeoutFetch,
  type AccountFetch,
  type BrainRouterAccountContext,
} from './accountIntegration.js';

export function reviewAssuranceDetailPath(jobId: unknown): string {
  if (typeof jobId !== 'string') throw new Error('Review job id must be a string.');
  const id = jobId.trim();
  if (!id || id.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9@._:-]*$/.test(id)) {
    throw new Error('Invalid review job id.');
  }
  return `/api/admin/reviews/jobs/${encodeURIComponent(id)}`;
}

function errorMessage(value: unknown, status: number): string {
  const body = value !== null && typeof value === 'object'
    ? value as { error?: unknown }
    : null;
  return typeof body?.error === 'string' && body.error.trim()
    ? body.error
    : `HTTP ${status}`;
}

/** Fetch and validate one renderer-safe assurance detail; credentials stay in Electron. */
export async function fetchAccountReviewAssurance(
  account: BrainRouterAccountContext,
  jobId: unknown,
  fetchImpl: AccountFetch = timeoutFetch,
): Promise<ReviewAssuranceDetailView> {
  const response = await fetchImpl(
    `${account.baseUrl}${reviewAssuranceDetailPath(jobId)}`,
    { headers: brainRouterAccountHeaders(account) },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  const detail = projectReviewAssuranceDetailView(body);
  if (!detail) throw new Error('The review service returned an invalid assurance detail.');
  return detail;
}
