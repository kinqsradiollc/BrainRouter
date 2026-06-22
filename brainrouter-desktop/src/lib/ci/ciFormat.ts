/**
 * Pure formatting for the GitHub CI/CD panel (T6). Maps `gh` JSON shapes
 * (pr checks rollup, actions runs) to display classes/labels. Kept pure +
 * node-testable; NO monaco/DOM imports. This is GitHub's real CI truth — the UI
 * must never conflate it with the app's local "tests passed".
 */
import { fmtDur } from '../format.js';

export interface CheckRow {
  name: string;
  state?: string;
  /** gh's rollup bucket: pass | fail | pending | skipping | cancel */
  bucket?: string;
  link?: string;
  workflow?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CheckSummary {
  total: number;
  passing: number;
  failing: number;
  pending: number;
  /** overall: any fail → failing; else any pending → pending; else passing; empty → none */
  conclusion: 'passing' | 'failing' | 'pending' | 'none';
}

/** Map a gh check bucket → a status class for the dot/badge. */
export function checkClass(bucket?: string): 'ok' | 'fail' | 'pending' | 'cancel' | 'neutral' {
  switch ((bucket ?? '').toLowerCase()) {
    case 'pass': return 'ok';
    case 'fail': return 'fail';
    case 'pending': return 'pending';
    case 'cancel': return 'cancel';
    case 'skipping': return 'neutral';
    default: return 'neutral';
  }
}

export function summarizeChecks(checks: CheckRow[]): CheckSummary {
  let passing = 0, failing = 0, pending = 0;
  for (const c of checks) {
    const k = checkClass(c.bucket);
    if (k === 'ok') passing++;
    else if (k === 'fail' || k === 'cancel') failing++;
    else if (k === 'pending') pending++;
  }
  const conclusion: CheckSummary['conclusion'] =
    checks.length === 0 ? 'none' : failing > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing';
  return { total: checks.length, passing, failing, pending, conclusion };
}

/** A short human label for the CI status chip — always prefixed so it reads as GitHub CI. */
export function ciStatusLabel(s: CheckSummary): string {
  if (s.conclusion === 'none') return 'No CI checks';
  if (s.conclusion === 'failing') return `CI: ${s.failing} failing${s.passing ? `, ${s.passing} passing` : ''}`;
  if (s.conclusion === 'pending') return `CI: ${s.pending} running${s.passing ? `, ${s.passing} passing` : ''}`;
  return `CI: ${s.passing} passing`;
}

/** Status/conclusion of one Actions run → a class. */
export function runClass(run: { status?: string; conclusion?: string }): 'ok' | 'fail' | 'pending' | 'cancel' | 'neutral' {
  if (run.status && run.status !== 'completed') return 'pending';
  switch ((run.conclusion ?? '').toLowerCase()) {
    case 'success': return 'ok';
    case 'failure': case 'timed_out': case 'startup_failure': return 'fail';
    case 'cancelled': return 'cancel';
    case 'skipped': case 'neutral': return 'neutral';
    default: return 'neutral';
  }
}

/** Run/check duration from two ISO timestamps; '' when either is missing. */
export function ciDuration(startISO?: string, endISO?: string): string {
  if (!startISO || !endISO) return '';
  const a = new Date(startISO).getTime(), b = new Date(endISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  return fmtDur(b - a);
}
