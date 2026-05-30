/**
 * MEM-9 (0.4.3) — retrieval benchmark summary + regression gate.
 *
 * One command that turns the per-mode result JSONs (written by the mode
 * benches, e.g. `longmemeval_fts.json` / `longmemeval_hybrid.json`) into a
 * single markdown comparison table and a CI pass/fail against thresholds.
 *
 *   npx tsx benchmark/bench-summary.ts <resultsDir> [--strict]
 *
 * Modes available today: fts, hybrid, hybrid+rerank (from longmemeval-bench).
 * tree / AST modes plug in by writing `longmemeval_tree.json` etc.
 */
import fs from "node:fs";
import path from "node:path";
import { formatModesSummaryMd, checkThresholds, type ModeStats, type ModeThreshold } from "../src/memory/bench/regression.js";

// Conservative default bars; tighten per dataset. Only modes present are gated.
const DEFAULT_THRESHOLDS: Record<string, ModeThreshold> = {
  fts: { recall_any_at_10: 0.25 },
  hybrid: { recall_any_at_10: 0.30 },
  "hybrid+rerank": { recall_any_at_10: 0.35 },
};

function loadStats(dir: string): Record<string, ModeStats> {
  const byMode: Record<string, ModeStats> = {};
  if (!fs.existsSync(dir)) return byMode;
  for (const file of fs.readdirSync(dir)) {
    const m = /^longmemeval_(.+)\.json$/.exec(file);
    if (!m) continue;
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    byMode[m[1]] = {
      recall_any_at_5: d.recall_any_at_5 ?? 0,
      recall_any_at_10: d.recall_any_at_10 ?? 0,
      recall_any_at_20: d.recall_any_at_20 ?? 0,
      ndcg_at_10: d.ndcg_at_10 ?? 0,
      mrr: d.mrr ?? 0,
    };
  }
  return byMode;
}

const dir = process.argv[2] ?? "benchmark/results/latest";
const strict = process.argv.includes("--strict");

const stats = loadStats(dir);
if (Object.keys(stats).length === 0) {
  console.error(`No longmemeval_*.json results in ${dir}. Run the mode benches first (e.g. npm run bench:longmemeval).`);
  process.exit(2);
}

const md = formatModesSummaryMd(stats);
fs.writeFileSync(path.join(dir, "SUMMARY.md"), md, "utf8");
process.stdout.write(md);

const gate = checkThresholds(stats, DEFAULT_THRESHOLDS);
if (!gate.passed) {
  process.stderr.write(`\nRegression threshold failures:\n${gate.failures.map((f) => `  - ${f}`).join("\n")}\n`);
  if (strict) process.exit(1);
}
