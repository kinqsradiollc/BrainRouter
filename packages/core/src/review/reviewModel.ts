/**
 * Local PR Review v2 — the shared review model used by BOTH heads (desktop +
 * CLI). Pure: types, diff-hash keying, stale detection, and the commit/push/PR
 * gate. The store (reviewStore.ts) persists it; the host/CLI run the reviewer.
 *
 * A review is keyed by the DIFF HASH it ran against. If the working diff changes
 * afterward, the run is stale and must be re-run (or explicitly bypassed) before
 * commit/push/create-PR.
 */
import crypto from 'node:crypto';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/**
 * Finding lifecycle. `open`/`stale` are the only BLOCKING states (see
 * `unresolvedBlocking`). `applied`/`fixed`/`dismissed` are the existing resolved
 * states. 0.4.15 adds three NON-BLOCKING triage states so a reviewer can clear a
 * finding from the gate without claiming code changed: `acknowledged` (seen,
 * accepted as-is), `disputed` (disagree with the finding), `out-of-scope` (real
 * but not for this change). All three are non-blocking by construction — the
 * gate only blocks `open`/`stale`.
 */
export type FindingStatus = 'open' | 'applied' | 'dismissed' | 'fixed' | 'stale' | 'acknowledged' | 'disputed' | 'out-of-scope';
export type RunStatus = 'running' | 'completed' | 'failed' | 'stale';

/** All finding statuses, for validation at the wire/store boundary. */
export const FINDING_STATUSES: readonly FindingStatus[] = ['open', 'applied', 'dismissed', 'fixed', 'stale', 'acknowledged', 'disputed', 'out-of-scope'];

/** Triage states a user can set to clear a finding from the gate (non-blocking, non-code-change). */
export const TRIAGE_STATUSES: readonly FindingStatus[] = ['acknowledged', 'disputed', 'out-of-scope'];

/** Narrow an unknown value to a {@link FindingStatus}. */
export function isFindingStatus(x: unknown): x is FindingStatus {
  return typeof x === 'string' && (FINDING_STATUSES as readonly string[]).includes(x);
}

export interface ReviewFinding {
  id: string;
  file: string;
  line?: number;
  endLine?: number;
  severity: Severity;
  confidence: number;
  summary: string;
  details?: string;
  suggestion?: string;
  /** A few verbatim lines of the affected code, for in-panel context. */
  codeExcerpt?: string;
  /** An optional unified-diff hunk (problem `-` lines + suggested `+` lines). */
  diffHunk?: string;
  /** A unified-diff/patch the UI can preview + apply, when the model provided one. */
  patch?: string;
  status: FindingStatus;
  canApply: boolean;
  source: 'ai-review';
  /**
   * Claude-style "Pre-existing" (🟣): a real bug in the code this diff touches
   * that the diff did NOT introduce. Informational — never blocks the gate
   * (unresolvedBlocking / reviewGate key off status + severity, not this flag).
   */
  preExisting?: boolean;
}

export interface ReviewRun {
  id: string;
  workspaceRoot: string;
  repoRoot: string;
  baseRef: string;
  headRef: string;
  diffHash: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  summary: string;
  findings: ReviewFinding[];
}

/** Stable hash of the working diff — the review key. Whitespace-insensitive at
 *  the line level so trivial re-formatting of the same change doesn't churn. */
export function hashDiff(diff: string): string {
  const normalized = (diff ?? '').replace(/\r\n/g, '\n').trimEnd();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

const SEV_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

/** Findings that still block: open (or stale) AND at/above the block threshold. */
export function unresolvedBlocking(run: ReviewRun | null, minSeverity: Severity = 'high'): ReviewFinding[] {
  if (!run) return [];
  const floor = SEV_RANK[minSeverity];
  return run.findings.filter((f) => (f.status === 'open' || f.status === 'stale') && SEV_RANK[f.severity] >= floor);
}

export type GateStatus = 'clean' | 'needs-review' | 'stale' | 'blocked' | 'running';

export interface GateResult {
  status: GateStatus;
  /** True → commit/push/create-PR is blocked unless the user explicitly bypasses. */
  blocked: boolean;
  reason: string;
  blockingFindings: ReviewFinding[];
}

/**
 * The single gate used by desktop + CLI before commit/push/create-PR.
 *  - no run for the current diff → needs-review (blocked)
 *  - run is for a DIFFERENT diff hash → stale (blocked)
 *  - run still running → running (blocked)
 *  - completed but unresolved critical/high → blocked
 *  - otherwise → clean
 */
export function reviewGate(run: ReviewRun | null, currentDiffHash: string, minSeverity: Severity = 'high'): GateResult {
  if (!run || run.diffHash !== currentDiffHash || run.status === 'stale') {
    const stale = !!run && run.diffHash !== currentDiffHash;
    return {
      status: stale ? 'stale' : 'needs-review',
      blocked: true,
      reason: stale ? 'The working changes changed since the last review — re-run it.' : 'No review has run for the current changes.',
      blockingFindings: [],
    };
  }
  if (run.status === 'running') return { status: 'running', blocked: true, reason: 'A review is still running.', blockingFindings: [] };
  if (run.status === 'failed') return { status: 'needs-review', blocked: true, reason: 'The last review failed — re-run it.', blockingFindings: [] };
  const blocking = unresolvedBlocking(run, minSeverity);
  if (blocking.length) {
    return { status: 'blocked', blocked: true, reason: `${blocking.length} unresolved ${minSeverity}+ finding(s) must be resolved, fixed, or dismissed.`, blockingFindings: blocking };
  }
  return { status: 'clean', blocked: false, reason: 'No unresolved blocking findings.', blockingFindings: [] };
}

/** Apply a status change to one finding, returning a NEW run (updatedAt bumped). */
export function setFindingStatus(run: ReviewRun, findingId: string, status: FindingStatus, now: string): ReviewRun {
  return {
    ...run,
    updatedAt: now,
    findings: run.findings.map((f) => (f.id === findingId ? { ...f, status } : f)),
  };
}

/** Mark the run stale if the working diff no longer matches the reviewed one. */
export function staleIfDiffChanged(run: ReviewRun, currentDiffHash: string): ReviewRun {
  if (run.diffHash === currentDiffHash || run.status === 'running') return run;
  return run.status === 'stale' ? run : { ...run, status: 'stale' };
}
