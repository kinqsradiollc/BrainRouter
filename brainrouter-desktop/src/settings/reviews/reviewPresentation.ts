export type ReviewExecutionMode = 'diff' | 'deep';

export interface ReviewListPresentation<T = unknown> {
  signedIn: boolean;
  canRun: boolean;
  reviews: T[];
  error: string | undefined;
}

export interface PullRequestReviewTarget {
  repo: string;
  prNumber: number;
  forge: 'github' | 'gitlab';
}

export interface ReviewActionAccess {
  loading: boolean;
  signedIn: boolean;
  canRun: boolean;
  error?: string;
}

export interface ReviewRunBridgeRequest extends PullRequestReviewTarget {
  lens: 'security' | 'code';
  mode: ReviewExecutionMode;
  deepReviewAccepted?: true;
}

export function reviewRunBridgeRequest(
  target: PullRequestReviewTarget,
  lens: 'security' | 'code',
  mode: ReviewExecutionMode,
  limitsAccepted: boolean,
): ReviewRunBridgeRequest {
  if (mode === 'deep' && !limitsAccepted) {
    throw new Error('Accept the displayed deep-review limits before starting this run.');
  }
  return mode === 'deep'
    ? { ...target, lens, mode, deepReviewAccepted: true }
    : { ...target, lens, mode: 'diff' };
}

export function reviewActionAvailability(access: ReviewActionAccess, target: PullRequestReviewTarget | null): { enabled: boolean; help: string } {
  if (access.loading) return { enabled: false, help: 'Checking BrainRouter review permissions…' };
  if (!access.signedIn) return { enabled: false, help: 'Sign in to BrainRouter to use organization reviews.' };
  if (access.error) return { enabled: false, help: `Reviews unavailable: ${access.error}` };
  if (!access.canRun) return { enabled: false, help: 'Your role can view reviews but needs the reviews:run capability to start one.' };
  if (!target) return { enabled: false, help: 'The repository could not be resolved for this change request.' };
  return { enabled: true, help: 'Runs with your organization policy and posts the result to this pull request.' };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function githubPullRequestUrl(repo: string, prNumber: number): string | null {
  const normalizedRepo = repo.trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepo)) return null;
  if (normalizedRepo.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return `https://github.com/${normalizedRepo}/pull/${prNumber}`;
}

export function changeRequestUrl(repo: string, prNumber: number, forge: 'github' | 'gitlab' = 'github'): string | null {
  const normalizedRepo = repo.trim();
  const parts = normalizedRepo.split('/');
  if (parts.length < 2 || (forge === 'github' && parts.length !== 2)) return null;
  if (parts.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return null;
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
  return forge === 'gitlab'
    ? `https://gitlab.com/${normalizedRepo}/-/merge_requests/${prNumber}`
    : `https://github.com/${normalizedRepo}/pull/${prNumber}`;
}

/** Resolve an org-review target from the canonical PR URL returned by GitHub or
 * GitHub Enterprise. Keeping this strict prevents a malformed local `gh` result
 * from reaching the account-scoped review endpoint. */
export function pullRequestReviewTarget(url: string | undefined, expectedNumber?: number): PullRequestReviewTarget | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const dash = parts.indexOf('-');
    if (dash >= 2 && parts[dash + 1] === 'merge_requests') {
      const repoParts = parts.slice(0, dash);
      if (repoParts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
      const prNumber = Number(parts[dash + 2]);
      if (!Number.isSafeInteger(prNumber) || prNumber <= 0 || (expectedNumber !== undefined && expectedNumber !== prNumber)) return null;
      return { repo: repoParts.join('/'), prNumber, forge: 'gitlab' };
    }
    if (parts.length < 4 || parts[2] !== 'pull') return null;
    const [owner, repo] = parts;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
    const prNumber = Number(parts[3]);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    if (expectedNumber !== undefined && expectedNumber !== prNumber) return null;
    return { repo: `${owner}/${repo}`, prNumber, forge: 'github' };
  } catch {
    return null;
  }
}

export function normalizeReviewListResponse<T = unknown>(value: unknown): ReviewListPresentation<T> {
  const body = asRecord(value);
  return {
    signedIn: body.signedIn === true,
    canRun: body.canRun === true,
    reviews: Array.isArray(body.reviews) ? body.reviews as T[] : [],
    error: typeof body.error === 'string' ? body.error : undefined,
  };
}
