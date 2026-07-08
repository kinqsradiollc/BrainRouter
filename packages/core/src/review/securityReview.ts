/**
 * PR-security-review — the "brain" of the GitHub App bot (ADR-017 D5). A read-only
 * reviewer runs over a checked-out PR with a SECURITY lens and returns findings in
 * the standard review JSON contract, so {@link parseReviewFindings} consumes the
 * output unchanged. This module supplies (a) the security prompt — a breadth-first
 * vulnerability taxonomy — and (b) an idempotent PR-review-comment renderer. Pure:
 * no network, no secrets echoed, safe to unit-test.
 */
import type { ParsedReviewFinding } from './reviewFindings.js';
import { REVIEW_OUTPUT_CONTRACT } from './reviewFindings.js';

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
 * The security-lens review prompt, appended after the diff/context. It reuses the
 * standard {@link REVIEW_OUTPUT_CONTRACT} JSON tail so the same parser works — the
 * reviewer just hunts security issues and prefixes each `summary` with the CWE id.
 */
export function buildSecurityReviewContract(): string {
  return (
    'You are a SECURITY reviewer for a pull request — review like an application-security engineer hunting for real, exploitable vulnerabilities the change introduces or exposes.\n' +
    'Sweep the change AND the code paths it touches (open callers/definitions with your read-only tools) for these classes:\n' +
    SECURITY_VULN_CLASSES.map((c) => `  - ${c}`).join('\n') + '\n' +
    'Prefix the JSON `summary` with the CWE id when known, e.g. "[CWE-89] SQL injection in buildUserQuery()". Put a short exploit/impact sketch plus the concrete file:line you verified in `details`, and the concrete remediation in `suggestion`.\n' +
    'Report a finding ONLY when you have verified BOTH a source (untrusted input) AND a sink (a dangerous operation it reaches) — an unproven guess is a false positive; prefer an empty array. Severity: exploitable-in-production / secret-leak / auth-bypass ⇒ "critical" or "high"; defense-in-depth / hardening ⇒ "low" or "info".\n' +
    '\n' +
    REVIEW_OUTPUT_CONTRACT
  );
}

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_EMOJI: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

/** A finding is blocking when it's a genuine (not pre-existing) critical/high issue. */
export function isBlockingSecurityFinding(f: ParsedReviewFinding): boolean {
  return (f.severity === 'critical' || f.severity === 'high') && !f.preExisting;
}

export interface SecurityCommentInput {
  findings: ParsedReviewFinding[];
  /** The PR head commit the review ran against (shown + used for staleness). */
  headSha: string;
  /** Cap listed findings to avoid a wall of text; extras are tallied, not listed. */
  maxListed?: number;
}

/**
 * Render an idempotent GitHub PR review comment. The stable {@link SECURITY_REVIEW_MARKER}
 * header lets the caller find + update its previous comment in place (one per PR),
 * so re-review on a new push replaces rather than stacks.
 */
export function formatSecurityReviewComment(input: SecurityCommentInput): string {
  const cap = input.maxListed ?? 20;
  const head = input.headSha ? input.headSha.slice(0, 7) : 'HEAD';
  const findings = [...input.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5));
  const out: string[] = [SECURITY_REVIEW_MARKER, '## 🛡️ BrainRouter security review', ''];

  if (findings.length === 0) {
    out.push('No security issues found in the changed code. ✅', '', `<sub>Reviewed \`${head}\` — read-only security sweep.</sub>`);
    return out.join('\n');
  }

  const blocking = findings.filter(isBlockingSecurityFinding).length;
  const bySev = findings.reduce<Record<string, number>>((a, f) => { a[f.severity] = (a[f.severity] ?? 0) + 1; return a; }, {});
  out.push(`**${blocking} blocking** · ${Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(' · ')}`, '');

  for (const f of findings.slice(0, cap)) {
    const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    out.push(`### ${SEV_EMOJI[f.severity] ?? '•'} ${f.summary}${f.preExisting ? ' _(pre-existing)_' : ''}`);
    out.push(`${loc}${typeof f.confidence === 'number' ? ` · confidence ${f.confidence}%` : ''}`);
    if (f.details) out.push('', f.details);
    if (f.suggestion) out.push('', `**Fix:** ${f.suggestion}`);
    if (f.codeExcerpt) out.push('', '```', f.codeExcerpt, '```');
    out.push('');
  }
  if (findings.length > cap) out.push(`…plus ${findings.length - cap} more finding(s) not shown.`, '');
  out.push(`<sub>Reviewed \`${head}\` — read-only security sweep; verify before acting.</sub>`);
  return out.join('\n');
}
