import type { ManualReviewRunRequest } from '@kinqs/brainrouter-types';
import { manualDeepReviewRequestConfig } from '@kinqs/brainrouter-types/review';

export type DesktopReviewRunRequestResult =
  | { ok: true; body: ManualReviewRunRequest }
  | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function desktopReviewRunRequest(value: unknown): DesktopReviewRunRequestResult {
  const input = record(value);
  const repo = String(input.repo ?? '');
  const prNumber = Number(input.prNumber);
  const forge = input.forge === 'gitlab' ? 'gitlab' : 'github';
  const lens = input.lens === 'security'
    || input.lens === 'code'
    || input.lens === 'pentest'
    || input.lens === 'both'
    ? input.lens
    : 'both';
  const mode = input.mode == null || input.mode === 'diff'
    ? 'diff'
    : input.mode === 'deep'
      ? 'deep'
      : null;
  const segments = repo.split('/');
  if (
    segments.length < 2
    || (forge === 'github' && segments.length !== 2)
    || segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')
    || !Number.isInteger(prNumber)
    || prNumber <= 0
  ) {
    return { ok: false, error: 'bad repo/prNumber' };
  }
  if (!mode) return { ok: false, error: 'bad review mode' };
  if (mode === 'deep' && (input.deepReviewAccepted !== true || lens === 'pentest')) {
    return {
      ok: false,
      error: 'Deep review requires deliberate acceptance of the displayed limits and cannot replace a pentest.',
    };
  }
  return {
    ok: true,
    body: {
      repo,
      prNumber,
      lens,
      forge,
      mode,
      ...(mode === 'deep' ? { deepReview: manualDeepReviewRequestConfig() } : {}),
    },
  };
}
