/**
 * ADR-027 D9 (P6-1) — the local pre-commit gate.
 *
 * The two gates get deliberately different engines. The PR gate is ADDITIVE:
 * evidence is required, uncertainty is recorded as `deferred`, coverage is
 * reported. This one is SUBTRACTIVE: it runs against uncommitted work, the
 * human is standing there waiting, and every false positive is paid for in the
 * most expensive currency there is — attention at the moment of committing.
 *
 * So findings are dropped unless they clear a bar. That is the opposite policy
 * from the PR gate and it is intentional: a local reviewer that cries wolf gets
 * switched off, and a switched-off reviewer reviews nothing. Owner decision,
 * recorded in §5: advisory by default, opt-in blocking.
 *
 * Three subtractions, in the order they run:
 *
 *   1. LANGUAGE-CONDITIONAL EXCLUSIONS. A memory-safety finding in a
 *      garbage-collected language is not a weak finding, it is a category
 *      error. Path traversal in front-end code likewise. These are dropped by
 *      rule, not by confidence.
 *   2. PRECEDENTS. A pattern the team has already looked at and accepted stays
 *      accepted. Re-litigating a settled decision every commit is how a gate
 *      trains people to dismiss it without reading.
 *   3. THE CONFIDENCE BAR. What survives must clear it.
 *
 * Every drop is COUNTED and attributed. A subtractive engine that silently
 * discards is indistinguishable from one that found nothing, and the difference
 * matters enormously when you are deciding whether to trust it.
 */

export interface LocalFinding {
  id: string;
  /** CWE or rule identifier, when known. */
  ruleId?: string;
  file: string;
  title: string;
  /** 0-100. Local gate demands a high bar; see DEFAULT_CONFIDENCE_BAR. */
  confidence: number;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
}

/** Coarse language classification, derived from the file, not guessed by a model. */
export type LanguageClass =
  | 'memory-safe'      // GC'd: TS/JS, Python, Go, Java, Ruby…
  | 'memory-unsafe'    // C, C++, unsafe Rust
  | 'frontend'         // browser-only code
  | 'config'
  | 'unknown';

export interface Precedent {
  /** Rule this precedent settles. */
  ruleId: string;
  /** Optional path prefix limiting the precedent's scope. */
  pathPrefix?: string;
  /** Why the team accepted it — shown when the drop is reported. */
  reason: string;
}

export interface SubtractionRecord {
  finding: LocalFinding;
  /** Which subtraction removed it. */
  by: 'language' | 'precedent' | 'confidence';
  reason: string;
}

export interface GateResult {
  kept: readonly LocalFinding[];
  dropped: readonly SubtractionRecord[];
  /** Advisory unless the workspace opted in — §5, owner decision. */
  blocking: boolean;
}

/** High by design: precision over recall at the moment of committing. */
export const DEFAULT_CONFIDENCE_BAR = 80;

/**
 * Rules that make a finding a CATEGORY ERROR rather than a weak one.
 *
 * Keyed by rule id, valued by the language classes where the rule cannot apply.
 * Deliberately small and explicit — a large inferred list would start dropping
 * real findings, which is the failure mode of any subtractive engine.
 */
const IMPOSSIBLE_IN: Record<string, readonly LanguageClass[]> = {
  'CWE-119': ['memory-safe', 'frontend', 'config'], // buffer overflow
  'CWE-120': ['memory-safe', 'frontend', 'config'],
  'CWE-125': ['memory-safe', 'frontend', 'config'], // out-of-bounds read
  'CWE-787': ['memory-safe', 'frontend', 'config'], // out-of-bounds write
  'CWE-416': ['memory-safe', 'frontend', 'config'], // use after free
  'CWE-415': ['memory-safe', 'frontend', 'config'], // double free
  'CWE-22': ['frontend', 'config'],                 // path traversal
  'CWE-78': ['frontend', 'config'],                 // OS command injection
  'CWE-89': ['frontend', 'config'],                 // SQL injection
};

export interface GateInput {
  findings: readonly LocalFinding[];
  /** Language class per file. Computed from extensions by the caller. */
  languageOf: (file: string) => LanguageClass;
  precedents?: readonly Precedent[];
  confidenceBar?: number;
  /** Opt-in per workspace. Default advisory — §5. */
  blocking?: boolean;
}

/**
 * Apply the subtractions, keeping a record of every drop.
 *
 * Order matters: a category error should be reported as such rather than as
 * "low confidence", because the two say different things about whether the
 * reviewer is working. Dropping it at the confidence step would hide a rule
 * that is firing where it cannot possibly apply.
 */
export function applySubtractiveGate(input: GateInput): GateResult {
  const bar = input.confidenceBar ?? DEFAULT_CONFIDENCE_BAR;
  const kept: LocalFinding[] = [];
  const dropped: SubtractionRecord[] = [];

  for (const finding of input.findings) {
    const language = input.languageOf(finding.file);

    const impossible = finding.ruleId ? IMPOSSIBLE_IN[finding.ruleId] : undefined;
    if (impossible?.includes(language)) {
      dropped.push({
        finding, by: 'language',
        reason: `${finding.ruleId} cannot apply in ${language} code.`,
      });
      continue;
    }

    const precedent = (input.precedents ?? []).find((p) =>
      p.ruleId === finding.ruleId
      && (p.pathPrefix === undefined || finding.file.startsWith(p.pathPrefix)));
    if (precedent) {
      dropped.push({ finding, by: 'precedent', reason: precedent.reason });
      continue;
    }

    if (finding.confidence < bar) {
      dropped.push({
        finding, by: 'confidence',
        reason: `Confidence ${finding.confidence} is below the local bar of ${bar}.`,
      });
      continue;
    }

    kept.push(finding);
  }

  return { kept, dropped, blocking: input.blocking === true };
}

/**
 * Whether this result should stop a commit.
 *
 * Advisory unless the workspace opted in AND something serious survived. §1's
 * evidence: a gate that blocks at the moment of commit is the one people route
 * around or switch off, and a switched-off gate reviews nothing.
 */
export function shouldBlockCommit(result: GateResult): boolean {
  return result.blocking
    && result.kept.some((f) => f.severity === 'critical' || f.severity === 'high');
}

/**
 * Report the result, including what was subtracted.
 *
 * The drop count is never hidden. A subtractive engine that silently discards
 * is indistinguishable from one that found nothing — and the difference decides
 * whether the tool is trustworthy.
 */
export function describeGateResult(result: GateResult): string {
  if (result.kept.length === 0 && result.dropped.length === 0) {
    return 'No findings.';
  }
  const parts: string[] = [];
  parts.push(result.kept.length === 0
    ? 'No findings met the local bar'
    : `${result.kept.length} finding(s) to review`);

  if (result.dropped.length > 0) {
    const byReason = new Map<SubtractionRecord['by'], number>();
    for (const record of result.dropped) {
      byReason.set(record.by, (byReason.get(record.by) ?? 0) + 1);
    }
    const summary = [...byReason.entries()].map(([by, n]) => `${n} ${by}`).join(', ');
    parts.push(`${result.dropped.length} suppressed (${summary})`);
  }
  return parts.join(' · ');
}
