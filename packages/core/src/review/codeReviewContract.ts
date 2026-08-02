/**
 * CODE-REVIEW lens (ADR-017 D5 extension) — the general software-quality reviewer that
 * runs ALONGSIDE the security lens on every PR. Grounded in the repo's own
 * `skills/codebase/code-review-and-quality` five-axis framework, but scoped to the
 * FOUR non-security axes (correctness, readability/simplicity, architecture,
 * performance) plus test coverage — the SECURITY axis is deliberately delegated to the
 * security lens so the two bots never double-report the same vulnerability. Same
 * single-shot, diff-only, no-tools framing as {@link buildSecurityReviewContract} so
 * the shared parser + inline-suggestion renderer are reused unchanged.
 */
import type { ParsedReviewFinding } from './reviewFindings.js';
import { type ReviewLens, isBlockingBySeverity } from './reviewLens.js';

/** The quality axes the code-review lens sweeps (security is handled by the security lens). */
export const CODE_REVIEW_AXES: readonly string[] = [
  'Correctness — wrong logic, unhandled edge cases (null/empty/boundary), missing error paths, off-by-one, race conditions, state left inconsistent, code that does not match its stated intent',
  'Readability & simplicity — unclear or misleading names, convoluted control flow, needless complexity or cleverness, code that could be far shorter, dead code / no-op variables / leftover shims',
  'Architecture — breaks an existing pattern without justification, wrong module boundary, duplication that should be shared, dependency pointing the wrong way, an abstraction that is not earning its complexity',
  'Performance — N+1 queries, unbounded loops or fetches, sync work that blocks, missing pagination on a list path, large allocations in a hot path',
  'Tests — new logic or a bug fix shipped with no test, or a test that does not actually exercise the change',
];

/** Stable HTML-comment marker so the bot can UPDATE its one code-review summary in place per PR. */
export const CODE_REVIEW_MARKER = '<!-- brainrouter-code-review -->';

/**
 * The code-review contract, appended AFTER the unified diff.
 *
 * ADR-027 D9.1 — conditional on whether exact-revision repository context was
 * attached, for the same reason as the security contract: asserting "no tools,
 * diff only" while context sits directly above it hands the model contradictory
 * instructions, and it follows the more specific one. Quality review suffers
 * from this even more sharply than security — whether a change is consistent
 * with the codebase is not answerable from a hunk.
 *
 * The no-tools framing remains correct, and required, when no context resolved.
 */
export function buildCodeReviewContract(options?: { repositoryContext?: boolean }): string {
  const grounded = options?.repositoryContext === true;
  return (
    'You are a senior software engineer reviewing a pull request for QUALITY (NOT security — a separate reviewer covers vulnerabilities; do not report injection / secrets / auth issues here). The unified diff is provided ABOVE — review it DIRECTLY. The added (`+`) lines are the new code.\n' +
    (grounded
      ? 'Exact-revision repository context for the changed files and their neighbours is provided ABOVE, as untrusted evidence. USE IT: whether a change fits the codebase cannot be judged from a hunk. Check how neighbouring code solves the same problem before calling something inconsistent, and treat a pattern repeated across unchanged call sites as the house convention rather than a defect. You still cannot request more files. Approve silently (empty array) when the change is clean; a good review is not a long one.\n'
      : 'You are a single-shot reviewer with NO tools: do not ask to open other files or run commands. Base every finding on evidence visible in the diff itself — a hunk header like `@@ -0,0 +1,18 @@` gives you the real line numbers. Approve silently (empty array) when the change is clean; a good review is not a long one.\n') +
    '\n' +
    'Evaluate the change across these axes and report only REAL, specific problems the diff introduces:\n' +
    CODE_REVIEW_AXES.map((a) => `  - ${a}`).join('\n') + '\n' +
    '\n' +
    'Severity: a bug that would break production, corrupt data, or ship broken behaviour ⇒ "critical" or "high"; a maintainability / clarity / minor-perf issue ⇒ "medium" or "low"; a nit ⇒ "info". Set "preExisting": true for a real problem in code the diff only *touches* (report for awareness; it never blocks). Do NOT invent problems, restate what the code does, or bikeshed style the project already accepts — every finding must be actionable.\n' +
    '\n' +
    'For `line`/`endLine`, give the EXACT new-file line numbers (read them off the `+` lines under the hunk header) — these anchor the inline comment, so be precise. When a safe drop-in fix exists, put the EXACT replacement for lines [line..endLine] in `replacement` (corrected code ONLY, no `+`/`-` diff prefixes, indentation preserved) so the author can apply it in one click; it must cover exactly those lines.\n' +
    '\n' +
    'Reply with a fenced ```json array of finding objects. Each object:\n' +
    '{"file": "<repo-relative path from the diff>", "line": <first affected new-file line>, "endLine": <last affected new-file line>, ' +
    '"severity": "critical|high|medium|low|info", "preExisting": <true only for a pre-existing issue|false>, "confidence": <0-100>, ' +
    '"summary": "<one line>", "details": "<which axis, what is wrong, and the concrete impact>", ' +
    '"suggestion": "<the concrete fix, in prose>", ' +
    '"replacement": "<exact corrected code for lines [line..endLine], verbatim, no diff prefixes — omit if no safe one-shot fix>", ' +
    '"codeExcerpt": "<the affected line(s) from the diff, verbatim, indentation preserved>"}.\n' +
    'Output ONLY the JSON array inside a single ```json fence — no prose before or after.'
  );
}

/** A code-review finding blocks the merge when it's a genuine (not pre-existing) critical/high bug. */
export function isBlockingCodeReviewFinding(f: ParsedReviewFinding): boolean {
  return isBlockingBySeverity(f);
}

/** The code-review lens: general software-quality review, one summary + inline suggestions per PR. */
export const CODE_REVIEW_LENS: ReviewLens = {
  id: 'code',
  summaryMarker: CODE_REVIEW_MARKER,
  inlineMarkerPrefix: 'brc',
  emoji: '🔎',
  name: 'BrainRouter code review',
  noFindingsLine: 'No code-quality issues found in the changed code. ✅',
  findingNoun: 'code-review finding',
  sweepLabel: 'code review',
  footerLabel: '🔎 BrainRouter code review',
  systemPrompt: 'You are a meticulous senior software engineer reviewing a pull request for correctness, clarity, architecture, performance, and test coverage.',
  advisory: true, // code review ADVISES (suggestions) — never gates the merge, not a required check
  buildContract: buildCodeReviewContract,
  isBlocking: isBlockingCodeReviewFinding,
};
