/**
 * 0.4.3 (MEM-9) — retrieval-benchmark regression gate + markdown summary.
 *
 * Pure functions over per-mode aggregate stats (the shape the existing
 * benchmark runners emit). They turn a set of mode results into a CI-friendly
 * pass/fail against thresholds and a human-readable markdown comparison table —
 * the "JSON + markdown summary; regression thresholds; CI-friendly" half of the
 * retrieval benchmark harness. Kept in `src/` (built + unit-tested) and imported
 * by the `benchmark/` runner.
 */

/** The subset of an aggregate-stats row the gate + summary care about. */
export interface ModeStats {
  recall_any_at_5: number;
  recall_any_at_10: number;
  recall_any_at_20: number;
  ndcg_at_10: number;
  mrr: number;
}

/** Per-mode minimum bars (any subset of metrics). A mode below any bar fails. */
export type ModeThreshold = Partial<ModeStats>;

export interface ThresholdResult {
  passed: boolean;
  failures: string[];
}

const PCT = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * Fail if any mode is missing, or any thresholded metric falls below its bar.
 * Used as a CI gate (exit non-zero when `!passed`).
 */
export function checkThresholds(
  statsByMode: Record<string, ModeStats>,
  thresholds: Record<string, ModeThreshold>,
): ThresholdResult {
  const failures: string[] = [];
  for (const [mode, th] of Object.entries(thresholds)) {
    const stats = statsByMode[mode];
    if (!stats) {
      failures.push(`${mode}: no results`);
      continue;
    }
    for (const [metric, min] of Object.entries(th)) {
      const value = (stats as unknown as Record<string, number>)[metric];
      if (typeof min === "number" && typeof value === "number" && value < min) {
        failures.push(`${mode}.${metric} ${PCT(value)} < min ${PCT(min)}`);
      }
    }
  }
  return { passed: failures.length === 0, failures };
}

/** Markdown comparison table across modes (stable column order). */
export function formatModesSummaryMd(statsByMode: Record<string, ModeStats>): string {
  const lines = [
    "# Retrieval benchmark — mode comparison",
    "",
    "| Mode | Recall@5 | Recall@10 | Recall@20 | nDCG@10 | MRR |",
    "|---|---|---|---|---|---|",
  ];
  for (const mode of Object.keys(statsByMode)) {
    const s = statsByMode[mode];
    lines.push(`| ${mode} | ${PCT(s.recall_any_at_5)} | ${PCT(s.recall_any_at_10)} | ${PCT(s.recall_any_at_20)} | ${PCT(s.ndcg_at_10)} | ${PCT(s.mrr)} |`);
  }
  return lines.join("\n") + "\n";
}
