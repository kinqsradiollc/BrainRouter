/**
 * Local PR Review v2 — persistence for the latest ReviewRun per workspace,
 * shared by desktop + CLI (same `.brainrouter` state, like scheduleStore). One
 * run is kept per workspace (the most recent); findings mutate in place as the
 * user applies/dismisses/resolves them. Pure model lives in reviewModel.ts.
 */
import { getStateFile, readJsonFile, writeJsonFile } from '../storage/store.js';
import { setFindingStatus, type ReviewRun, type FindingStatus } from './reviewModel.js';
import { reviewRunToSarif } from './sarif.js';

const FILE_NAME = 'review.json';
function file(workspaceRoot: string): string {
  return getStateFile(workspaceRoot, FILE_NAME);
}

export function getLatestReview(workspaceRoot: string): ReviewRun | null {
  return readJsonFile<ReviewRun | null>(file(workspaceRoot), null);
}

export function saveReview(workspaceRoot: string, run: ReviewRun): void {
  writeJsonFile(file(workspaceRoot), run);
  // Completed review/pentest runs are portable to code-scanning and ASPM tools.
  // Do not emit partial SARIF for an in-progress run; it can otherwise look like
  // a clean scan while workers are still discovering findings.
  if (run.status === 'completed') writeJsonFile(getStateFile(workspaceRoot, 'findings.sarif'), reviewRunToSarif(run));
}

export function clearReview(workspaceRoot: string): void {
  writeJsonFile(file(workspaceRoot), null as unknown as ReviewRun);
}

/** Mutate one finding's status (apply/dismiss/resolve), persisting the run. */
export function updateReviewFinding(workspaceRoot: string, findingId: string, status: FindingStatus, now: string): ReviewRun | null {
  const run = getLatestReview(workspaceRoot);
  if (!run) return null;
  const next = setFindingStatus(run, findingId, status, now);
  saveReview(workspaceRoot, next);
  return next;
}
