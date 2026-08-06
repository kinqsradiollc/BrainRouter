/**
 * PR-security-review — the "brain" of the GitHub App bot (ADR-017 D5). Driven by a
 * `pull_request` webhook, the bot runs a SINGLE-SHOT LLM over the PR's unified diff
 * (no filesystem tools, no checkout) and returns findings in the standard review
 * JSON contract, so {@link parseReviewFindings} consumes the output unchanged. This
 * module supplies (a) the security prompt — a breadth-first vulnerability taxonomy
 * written for diff-only review — and (b) an idempotent PR-review-comment renderer.
 * Pure: no network, no secrets echoed, safe to unit-test.
 */
import type { ParsedReviewFinding } from './reviewFindings.js';
import { buildGroundingClause } from './reviewGrounding.js';
import { type ReviewLens, isBlockingBySeverity } from './reviewLens.js';

/** The vulnerability classes the reviewer sweeps for (breadth over a code change). */
export const SECURITY_VULN_CLASSES: readonly string[] = [
  'SQL / NoSQL injection',
  'Command / code injection (RCE)',
  'Cross-site scripting (XSS)',
  'Server-side request forgery (SSRF)',
  'Server-side template injection (SSTI)',
  'XML external entities (XXE)',
  'Path traversal / LFI / RFI',
  'Insecure deserialization',
  'Prototype pollution',
  'Mass assignment',
  'Insecure direct object reference (IDOR) / broken object-level authorization',
  'Broken function-level authorization',
  'Authentication / session / JWT flaws',
  'Weak password / credential policy (missing complexity or rate-limiting, default or system-predictable credentials)',
  'Cross-site request forgery (CSRF)',
  'Open redirect',
  'HTTP header injection / request smuggling',
  'Hardcoded secrets / credential leakage',
  'Sensitive information disclosure',
  'Insecure file upload',
  'Race conditions / TOCTOU',
  'Weak cryptography / insufficient randomness',
  'LLM prompt injection',
  'Missing input validation / output encoding',
  'Unsafe dependency / supply-chain usage',
];

/** Stable HTML-comment marker so the bot can UPDATE its one comment in place per PR. */
export const SECURITY_REVIEW_MARKER = '<!-- brainrouter-security-review -->';

/**
 * The security-lens review prompt, appended AFTER the unified diff.
 *
 * ADR-027 D9.1 — this contract is now CONDITIONAL on whether exact-revision
 * repository context was attached above.
 *
 * It used to assert unconditionally that the reviewer had no tools and must
 * base every finding on the diff alone. That was true when written, but the
 * scheduler has since gained a real checkout and a `prepareRepositoryContext`
 * hook — so the prompt was contradicting the evidence sitting directly above
 * it. Handed both, a model follows the stronger, more specific instruction and
 * reasons from the diff only, which is exactly how a guard twenty lines below a
 * hunk goes unseen and a false positive gets filed.
 *
 * The no-tools framing is still correct when NO context was resolved, and must
 * stay: told to "verify with read-only tools" it does not have, the model
 * concludes it could not verify and suppresses every finding.
 *
 * The signature stays a boolean rather than taking a {@link ReviewEvidenceMode}
 * so the backend is structurally incapable of promising itself tools it does
 * not have on this path.
 */
export function buildSecurityReviewContract(options?: { repositoryContext?: boolean }): string {
  const mode = options?.repositoryContext === true ? 'attached-context' : 'diff-only';
  return (
    'You are a SECURITY reviewer for a pull request. The unified diff is provided ABOVE — review it DIRECTLY. The added (`+`) lines are the new code; scrutinise them for vulnerabilities the change introduces or exposes.\n' +
    buildGroundingClause(mode) + '\n' +
    '\n' +
    'Sweep for these vulnerability classes:\n' +
    SECURITY_VULN_CLASSES.map((c) => `  - ${c}`).join('\n') + '\n' +
    '\n' +
    'Report a finding when the diff shows BOTH an untrusted SOURCE and a dangerous SINK it reaches — e.g. request input (req.query / req.params / req.body / argv / env / headers) flowing into a SQL/NoSQL query, a shell command, a file path, HTML, a template, a deserializer, or a redirect; or a hardcoded secret / credential committed in the change. Prefix the `summary` with the CWE id when known, e.g. "[CWE-89] SQL injection in the /user handler". Use the MOST SPECIFIC child CWE, never a broad parent — CWE-89 not CWE-74, CWE-78 not CWE-77, CWE-639 not CWE-284; avoid the umbrella CWEs CWE-74 / CWE-20 / CWE-200 / CWE-284 / CWE-693, and omit the CWE entirely if you are unsure rather than guessing a broad one.\n' +
    'Severity: exploitable-in-production / secret leak / auth bypass ⇒ "critical" or "high"; defense-in-depth / hardening ⇒ "low" or "info". An empty array is correct ONLY when the change genuinely introduces no security issue — do not invent problems, but do NOT stay silent about a vulnerability that is plainly visible in the diff.\n' +
    '\n' +
    'For `line`/`endLine`, give the EXACT new-file line numbers of the vulnerable code (read them off the `+` lines under the hunk header) — these anchor the inline comment, so they must be precise. When a safe drop-in fix exists, put the EXACT replacement for lines [line..endLine] in `replacement` (the corrected code ONLY, no `+`/`-` diff prefixes, indentation preserved) so the author can apply it in one click; it must cover exactly those lines.\n' +
    '\n' +
    'Reply with a fenced ```json array of finding objects. Each object:\n' +
    '{"file": "<repo-relative path from the diff>", "line": <first affected new-file line>, "endLine": <last affected new-file line>, ' +
    '"severity": "critical|high|medium|low|info", "confidence": <0-100>, ' +
    '"summary": "<one line, CWE-prefixed>", "details": "<the source, the sink, and the concrete exploit/impact>", ' +
    '"suggestion": "<the concrete remediation, in prose>", ' +
    '"replacement": "<exact corrected code for lines [line..endLine], verbatim, no diff prefixes — omit if no safe one-shot fix>", ' +
    '"codeExcerpt": "<the vulnerable line(s) from the diff, verbatim, indentation preserved>"}.\n' +
    'Output ONLY the JSON array inside a single ```json fence — no prose before or after.'
  );
}

/** A finding is blocking when it's a genuine (not pre-existing) critical/high issue. */
export function isBlockingSecurityFinding(f: ParsedReviewFinding): boolean {
  return isBlockingBySeverity(f);
}

/** The security lens: vulnerability review, one summary + inline suggestions per PR. */
export const SECURITY_LENS: ReviewLens = {
  id: 'security',
  summaryMarker: SECURITY_REVIEW_MARKER,
  inlineMarkerPrefix: 'brs',
  emoji: '🛡️',
  name: 'BrainRouter security review',
  noFindingsLine: 'No security issues found in the changed code. ✅',
  findingNoun: 'security finding',
  sweepLabel: 'security sweep',
  footerLabel: '🛡️ BrainRouter security',
  systemPrompt: 'You are a meticulous application-security reviewer for pull requests.',
  advisory: false, // security GATES the merge
  buildContract: buildSecurityReviewContract,
  isBlocking: isBlockingSecurityFinding,
};
