/**
 * Review LENS abstraction (ADR-017 D5, code-review extension).
 *
 * The PR bot runs one or more *lenses* over a pull request's unified diff — today a
 * SECURITY lens (vulnerability taxonomy) and a general CODE-REVIEW lens (correctness /
 * readability / architecture / performance / tests). Every lens shares the SAME
 * single-shot pipeline: build a diff-only contract → `parseReviewFindings` →
 * `resolveInlineAnchor` → render inline cards + a pinned summary → (optionally) a
 * gating check-run. Only the *prompt*, the *markers*, and a few labels differ per
 * lens. This module is the one place that rendering lives — so a new lens is a data
 * object, not a copy of the executor + formatters.
 */
import type { ParsedReviewFinding } from './reviewFindings.js';

/** A review lens: everything that differs between security / code-review / (future) lenses. */
export interface ReviewLens {
  /** Short id used in job kinds, taskIds, and check-run names: 'security' | 'code'. */
  id: string;
  /** Idempotent pinned-summary comment marker (one summary per lens per PR). */
  summaryMarker: string;
  /** Per-finding inline-comment marker prefix — dedups re-runs AND isolates lenses on the same line. */
  inlineMarkerPrefix: string;
  /** Emoji shown before the lens name. */
  emoji: string;
  /** Human name, e.g. 'BrainRouter security review'. */
  name: string;
  /** Summary line when a review found nothing. */
  noFindingsLine: string;
  /** Singular noun for tallies/intros, e.g. 'security finding' → "flagged 3 new security findings". */
  findingNoun: string;
  /** Short label for the summary footer, e.g. 'security sweep'. */
  sweepLabel: string;
  /** Credit line on each inline card, e.g. '🛡️ BrainRouter security'. */
  footerLabel: string;
  /** System prompt for the reviewer LLM turn. */
  systemPrompt: string;
  /**
   * Advisory lens: its check-run NEVER fails (findings are suggestions, not merge gates),
   * so it isn't a required CI check. Security gates; code review advises.
   */
  advisory: boolean;
  /** The single-shot, diff-only review contract appended after the diff. */
  buildContract(): string;
  /** Whether a finding should BLOCK the merge (drives the check-run conclusion). */
  isBlocking(f: ParsedReviewFinding): boolean;
}

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_EMOJI: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };
const CWE_RE = /\[(CWE-\d+)\]/i;

/**
 * The Strix-style action row on every summary — LENS-AWARE: re-run THIS lens on
 * demand (security → `/security-review`, code → `/code-review`; legacy `/review`
 * runs both) + where to manage the bot (BrainRouter's own app/dashboard, not a
 * third party). The command names match the webhook parser (ADR-017 review console).
 */
export function reviewActionFooter(lens: ReviewLens): string {
  const cmd = lens.id === 'security' ? '/security-review' : '/code-review';
  return `🔁 **Re-run:** comment \`${cmd}\` (or \`/review\` for both) · ⚙️ **Manage:** BrainRouter app → Reviews or the dashboard`;
}

/** Default blocking rule shared by lenses: a genuine (not pre-existing) critical/high issue. */
export function isBlockingBySeverity(f: ParsedReviewFinding): boolean {
  return (f.severity === 'critical' || f.severity === 'high') && !f.preExisting;
}

/**
 * A stable per-finding HTML-comment marker embedded in each INLINE review comment, so
 * a re-run can skip a finding it already posted (dedup by path + summary) and the
 * review says "N NEW findings" instead of stacking. The lens prefix keeps the SECURITY
 * and CODE lenses from clobbering each other's dedup on the same line.
 */
export function inlineFindingMarker(lens: ReviewLens, f: ParsedReviewFinding): string {
  const slug = `${f.file}:${f.summary}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 90);
  return `<!-- ${lens.inlineMarkerPrefix}-finding:${slug} -->`;
}

/** Regex matching THIS lens's inline markers (for dedup scanning of existing comments). */
export function inlineMarkerRegex(lens: ReviewLens): RegExp {
  return new RegExp(`<!-- ${lens.inlineMarkerPrefix}-finding:[^>]+ -->`);
}

/**
 * Render ONE inline PR-review comment for a finding — the Strix-style card: a titled
 * severity(+CWE) header, the impact, and (when safe) a GitHub ```suggestion block the
 * author can Apply in one click, plus a collapsed "prompt to fix with AI". `suggestable`
 * comes from {@link resolveInlineAnchor} — only true when the exact line range is in the diff.
 */
export function formatInlineFinding(lens: ReviewLens, f: ParsedReviewFinding, opts?: { suggestable?: boolean }): string {
  const emoji = SEV_EMOJI[f.severity] ?? '•';
  const cwe = CWE_RE.exec(f.summary)?.[1];
  const title = f.summary.replace(/^\s*\[CWE-\d+\]\s*/i, '').trim();
  const out: string[] = [inlineFindingMarker(lens, f)];
  out.push(`### ${emoji} ${title}`);
  out.push(
    `**Severity:** ${f.severity.toUpperCase()}` +
      (cwe ? ` · **${cwe}**` : '') +
      (typeof f.confidence === 'number' ? ` · confidence ${f.confidence}%` : '') +
      (f.preExisting ? ' · _pre-existing_' : ''),
  );
  if (f.details) out.push('', f.details);
  if (opts?.suggestable && f.replacement) {
    out.push('', '```suggestion', f.replacement.replace(/\n+$/, ''), '```');
  } else if (f.suggestion) {
    out.push('', `**Fix:** ${f.suggestion}`);
  }
  const promptFix = (f.suggestion || f.details || title).replace(/\s+/g, ' ').trim();
  const loc = `${f.file}${f.line ? `:${f.line}` : ''}`;
  out.push(
    '',
    '<details><summary>💬 Prompt to fix with AI</summary>',
    '',
    '```text',
    `Fix the ${cwe ? `${cwe} ` : ''}issue "${title}" in ${loc}. ${promptFix}`,
    '```',
    '</details>',
  );
  out.push('', `<sub>${lens.footerLabel} · react 👍/👎 to tune · resolve this thread to dismiss.</sub>`);
  return out.join('\n');
}

/** The top-level body of the grouped PR review (Strix-style "flagged N new findings"). */
export function buildReviewIntro(lens: ReviewLens, newCount: number): string {
  if (newCount <= 0) return `${lens.emoji} **${lens.name}** — no new ${lens.findingNoun}s on this revision. ✅`;
  return (
    `${lens.emoji} **${lens.name}** flagged **${newCount}** new ${lens.findingNoun}${newCount === 1 ? '' : 's'} inline below. ` +
    'See the pinned summary comment for the full PR status.'
  );
}

export interface ReviewSummaryInput {
  findings: ParsedReviewFinding[];
  /** The PR head commit the review ran against (shown + used for staleness). */
  headSha: string;
  /** Cap listed findings to avoid a wall of text; extras are tallied, not listed. */
  maxListed?: number;
}

/**
 * Render an idempotent GitHub PR SUMMARY comment for a lens. The stable
 * `lens.summaryMarker` header lets the caller find + update its previous comment in
 * place (one per lens per PR), so re-review on a new push replaces rather than stacks.
 */
export function formatReviewSummaryComment(lens: ReviewLens, input: ReviewSummaryInput): string {
  const cap = input.maxListed ?? 20;
  const head = input.headSha ? input.headSha.slice(0, 7) : 'HEAD';
  const findings = [...input.findings].sort((a, b) => (SEV_ORDER[a.severity] ?? 5) - (SEV_ORDER[b.severity] ?? 5));
  const out: string[] = [lens.summaryMarker, `## ${lens.emoji} ${lens.name}`, ''];

  if (findings.length === 0) {
    out.push(lens.noFindingsLine, '', reviewActionFooter(lens), '', `<sub>Reviewed \`${head}\` — read-only ${lens.sweepLabel}.</sub>`);
    return out.join('\n');
  }

  const blocking = findings.filter((f) => lens.isBlocking(f)).length;
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
  out.push(reviewActionFooter(lens), '');
  out.push(`<sub>Reviewed \`${head}\` — read-only ${lens.sweepLabel}; verify before acting.</sub>`);
  return out.join('\n');
}
