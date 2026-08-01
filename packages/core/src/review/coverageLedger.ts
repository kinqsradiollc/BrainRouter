/**
 * ADR-027 D9.1 (P6-5) — the coverage denominator.
 *
 * Existing review coverage counts DIFF PARTS: how many chunks of the patch were
 * sent to the model. That answers "did we finish streaming the diff", not "what
 * did this review actually look at". With repository grounding the question
 * changes, and the old counter cannot answer it: a file the model never opened
 * is indistinguishable from a file it opened and cleared.
 *
 * So coverage becomes file-level and total. Every path in the in-scope
 * inventory lands in EXACTLY ONE bucket:
 *
 *   reviewed   — the model reasoned about it
 *   excluded   — dropped by a NAMED rule, with its reason recorded
 *   unreviewed — in scope, not excluded, not looked at. The honest gap.
 *
 * Anonymous exclusion is the thing this design refuses. "We skipped it" without
 * a rule id is how a reviewer quietly stops covering a directory and nobody
 * notices for six months. An auditor must be able to see WHY something did not
 * become a finding, which requires knowing it was considered at all.
 *
 * The inventory itself is produced deterministically OUTSIDE the model (a
 * sorted file listing), so it cannot drift with the model's mood or context
 * window. This module is the accounting over it.
 */

/** A named reason a path is deliberately not reviewed. */
export interface ExclusionRule {
  /** Stable id, recorded against every path it drops. */
  id: string;
  /** Human-readable justification, shown in the coverage report. */
  reason: string;
  /** True when this rule claims the path. */
  matches(path: string): boolean;
}

export interface ExcludedFile {
  path: string;
  ruleId: string;
  reason: string;
}

export interface CoverageReport {
  /** Size of the in-scope inventory — the denominator. */
  total: number;
  reviewed: readonly string[];
  excluded: readonly ExcludedFile[];
  /** In scope, not excluded, and never looked at. */
  unreviewed: readonly string[];
  /**
   * Paths the reviewer claimed to review that are NOT in the inventory.
   *
   * Usually a hallucinated or stale path. Surfaced rather than ignored because
   * a review citing files that do not exist is reporting on something other
   * than this revision.
   */
  outOfScope: readonly string[];
  /** True only when nothing is left unreviewed. Exclusions do not spoil it. */
  complete: boolean;
}

/**
 * Default exclusions. Each carries a reason, because a rule whose justification
 * cannot be written down is usually not a rule — it is an oversight.
 */
export const DEFAULT_EXCLUSIONS: readonly ExclusionRule[] = [
  {
    id: 'lockfile',
    reason: 'Dependency lockfiles are generated; review the manifest change instead.',
    matches: (p) => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$/.test(p),
  },
  {
    id: 'generated',
    reason: 'Generated output; the generator or its input is the reviewable artifact.',
    matches: (p) => /(^|\/)(dist|build|out|coverage|__generated__|node_modules)\//.test(p)
      || /\.(min\.js|min\.css|map)$/.test(p),
  },
  {
    id: 'binary',
    reason: 'Binary or media asset; not reviewable as source.',
    matches: (p) => /\.(png|jpe?g|gif|webp|ico|svgz|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mp3|wasm)$/i.test(p),
  },
  {
    id: 'vendored',
    reason: 'Third-party code carried in-tree; upstream owns its review.',
    matches: (p) => /(^|\/)(vendor|third_party|thirdparty)\//.test(p),
  },
];

/**
 * Account for every in-scope path.
 *
 * Precedence is reviewed > excluded: if the model actually looked at a
 * generated file, that is a fact worth recording rather than overwriting with
 * "we skipped it". Reporting it as excluded would misdescribe the run.
 */
export function buildCoverageReport(input: {
  inventory: readonly string[];
  reviewed: readonly string[];
  exclusions?: readonly ExclusionRule[];
}): CoverageReport {
  const inventory = [...new Set(input.inventory)].sort();
  const inventorySet = new Set(inventory);
  const reviewedSet = new Set(input.reviewed);
  const rules = input.exclusions ?? DEFAULT_EXCLUSIONS;

  const reviewed: string[] = [];
  const excluded: ExcludedFile[] = [];
  const unreviewed: string[] = [];

  for (const path of inventory) {
    if (reviewedSet.has(path)) { reviewed.push(path); continue; }
    const rule = rules.find((candidate) => candidate.matches(path));
    if (rule) { excluded.push({ path, ruleId: rule.id, reason: rule.reason }); continue; }
    unreviewed.push(path);
  }

  const outOfScope = [...new Set(input.reviewed)].filter((path) => !inventorySet.has(path)).sort();

  return {
    total: inventory.length,
    reviewed,
    excluded,
    unreviewed,
    outOfScope,
    complete: unreviewed.length === 0,
  };
}

/**
 * Render coverage for a human.
 *
 * Silence about a gap reads as "covered everything", so an incomplete run must
 * say so in words and name what it missed — not merely report a percentage that
 * a reader has to interpret.
 */
export function describeCoverage(report: CoverageReport): string {
  if (report.total === 0) return 'No files were in scope for this review.';

  const parts = [`${report.reviewed.length}/${report.total} in-scope file(s) reviewed`];
  if (report.excluded.length > 0) {
    const byRule = new Map<string, number>();
    for (const file of report.excluded) byRule.set(file.ruleId, (byRule.get(file.ruleId) ?? 0) + 1);
    const summary = [...byRule.entries()].map(([id, n]) => `${n} ${id}`).join(', ');
    parts.push(`${report.excluded.length} excluded by rule (${summary})`);
  }
  if (report.unreviewed.length > 0) {
    const shown = report.unreviewed.slice(0, 5).join(', ');
    const more = report.unreviewed.length > 5 ? ` and ${report.unreviewed.length - 5} more` : '';
    parts.push(`**${report.unreviewed.length} NOT reviewed**: ${shown}${more}`);
  }
  if (report.outOfScope.length > 0) {
    parts.push(`${report.outOfScope.length} cited path(s) are not in this revision: ${report.outOfScope.slice(0, 3).join(', ')}`);
  }
  return parts.join(' · ');
}
