/**
 * MAS-P5-T1 (0.4.2) — confidence-scored review fan-out: parent synthesis.
 *
 * `/review-auto` spawns N specialized reviewers; each returns findings with
 * a `confidence` (0-100). This module is the deterministic synthesis the
 * parent runs over the pooled findings:
 *
 *   1. Dedupe by `(file, line-range, root-cause-hash)` — the same issue
 *      flagged by two reviewers collapses to one, keeping the HIGHEST
 *      confidence and unioning which reviewers raised it.
 *   2. Filter out anything below the confidence threshold. Dropped
 *      findings are returned separately so they can stay in the child
 *      transcript for audit (not silently discarded).
 *
 * Pure (no I/O) so the threshold + dedupe behaviour unit-tests cleanly.
 */

export interface ReviewFinding {
  /** File the finding concerns. */
  file: string;
  /** Single line, or a `start-end` range. Optional. */
  line?: number | null;
  lineEnd?: number | null;
  severity: string;
  /** 0-100. Findings below the threshold are filtered out. */
  confidence: number;
  /** Short description of the issue. */
  summary: string;
  /** Reviewer that raised it (for provenance + dedupe union). */
  reviewer?: string;
  /**
   * Optional explicit root-cause tag. When absent, a normalized hash of
   * the summary stands in so near-identical descriptions dedupe.
   */
  rootCause?: string;
}

/** Normalize free text for hashing: lowercase, collapse whitespace, strip punctuation. */
function normalize(text: string): string {
  return (text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A small stable hash (so the dedupe key is compact + deterministic). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Dedupe key: `(file, line-range, root-cause-hash)`. The line range
 * buckets nearby lines together (same span), and the root cause is the
 * explicit tag if given, else a hash of the normalized summary.
 */
export function findingKey(f: ReviewFinding): string {
  const lo = f.line ?? '';
  const hi = f.lineEnd ?? f.line ?? '';
  const cause = f.rootCause ? normalize(f.rootCause) : hash(normalize(f.summary));
  return `${f.file}|${lo}-${hi}|${cause}`;
}

export interface ReviewSynthesis {
  /** Deduped findings at/above threshold, sorted by confidence desc. */
  kept: ReviewFinding[];
  /** Deduped findings below threshold (kept for the audit trail). */
  dropped: ReviewFinding[];
}

/**
 * Merge duplicate findings (max confidence wins; reviewers unioned) then
 * split by the confidence threshold.
 */
export function mergeAndFilterFindings(findings: ReviewFinding[], threshold: number): ReviewSynthesis {
  const merged = new Map<string, ReviewFinding & { reviewers: Set<string> }>();
  for (const f of findings) {
    const key = findingKey(f);
    const existing = merged.get(key);
    if (existing) {
      if (f.reviewer) existing.reviewers.add(f.reviewer);
      if (f.confidence > existing.confidence) {
        existing.confidence = f.confidence;
        existing.severity = f.severity;
        existing.summary = f.summary;
      }
    } else {
      merged.set(key, { ...f, reviewers: new Set(f.reviewer ? [f.reviewer] : []) });
    }
  }
  const all = Array.from(merged.values())
    .map((m) => {
      const { reviewers, ...rest } = m;
      const list = Array.from(reviewers);
      return { ...rest, reviewer: list.length ? list.sort().join('+') : rest.reviewer };
    })
    .sort((a, b) => b.confidence - a.confidence);

  return {
    kept: all.filter((f) => f.confidence >= threshold),
    dropped: all.filter((f) => f.confidence < threshold),
  };
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, important: 1, medium: 2, low: 3 };

/** Render the kept findings as a severity-ordered markdown report. */
export function renderReviewReport(synth: ReviewSynthesis, threshold: number): string {
  if (synth.kept.length === 0) {
    return `No issues found at or above confidence ${threshold}. (${synth.dropped.length} lower-confidence finding(s) left in child transcripts.)`;
  }
  const ordered = [...synth.kept].sort((a, b) => {
    const sa = SEVERITY_RANK[a.severity.toLowerCase()] ?? 5;
    const sb = SEVERITY_RANK[b.severity.toLowerCase()] ?? 5;
    return sa - sb || b.confidence - a.confidence;
  });
  const lines: string[] = [`# Review findings (confidence ≥ ${threshold})`, ''];
  for (const f of ordered) {
    const loc = f.line ? `${f.file}:${f.line}${f.lineEnd && f.lineEnd !== f.line ? `-${f.lineEnd}` : ''}` : f.file;
    const who = f.reviewer ? ` _(${f.reviewer})_` : '';
    lines.push(`- **[${f.severity}]** \`${loc}\` — ${f.summary} (confidence ${f.confidence})${who}`);
  }
  if (synth.dropped.length) {
    lines.push('', `_${synth.dropped.length} finding(s) below threshold retained in child transcripts for audit._`);
  }
  return lines.join('\n');
}

/** Default reviewer roster for `/review-auto`. */
export const DEFAULT_REVIEW_ROSTER = [
  'instruction-reviewer',
  'bug-reviewer',
  'test-reviewer',
  'history-reviewer',
  'simplification',
] as const;

export const DEFAULT_REVIEW_THRESHOLD = 80;
