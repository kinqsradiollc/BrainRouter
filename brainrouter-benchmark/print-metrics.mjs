// Print the metrics for one system from the most recent matching retrieval run.
//   node print-metrics.mjs <systemId> [fixture]
import fs from "node:fs";
import path from "node:path";

const [sysId, fixture] = process.argv.slice(2);
const root = "results/memory";
if (!sysId || !fs.existsSync(root)) {
  console.log("    → no results");
  process.exit(0);
}
const runs = fs
  .readdirSync(root)
  .map((d) => path.join(root, d, "summary.json"))
  .filter((p) => fs.existsSync(p))
  .map((p) => ({ m: fs.statSync(p).mtimeMs, s: JSON.parse(fs.readFileSync(p, "utf8")) }))
  .filter((x) => x.s?.config?.suite === "retrieval" && (!fixture || x.s.config.fixture === fixture))
  .sort((a, b) => b.m - a.m);

const f = (x) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(2) : "-");
for (const { s } of runs) {
  const r = s.results.find((r) => r.systemId === sysId);
  if (!r) continue;
  const m = r.metrics || {};
  if (r.status !== "passed") {
    console.log(`    → ${sysId} [${r.status}]${r.unavailableReason ? " " + r.unavailableReason : ""}`);
    process.exit(0);
  }
  console.log(
    `    → ${sysId}  R@5=${f(m.recallAt5)}  R@10=${f(m.recallAt10)}  R@20=${f(m.recallAt20)}  ` +
      `P@5=${f(m.precisionAt5)}  nDCG=${f(m.ndcgAt10)}  MRR=${f(m.mrr)}  ` +
      `p50=${m.p50Ms != null ? Math.round(m.p50Ms) + "ms" : "-"}`,
  );
  process.exit(0);
}
console.log(`    → ${sysId}: no result found yet`);
