// Builds a writeup-ready memory comparison report from the retrieval runs in
// results/memory/. Groups by MemBench split; one row per system
// (baselines + brainrouter-precision + brainrouter-recall).
//
//   node build-comparison-report.mjs [> reports/memory-comparison.md]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("results/memory");

// Baselines (fixed order) — the standard memory alternatives.
const BASELINE_ROWS = [
  ["baseline-full-dump", "Full-context dump"],
  ["baseline-capped-dump", "Capped dump (recency 200)"],
  ["baseline-bm25", "BM25 (lexical)"],
  ["baseline-vector", "Vector (embedding)"],
  ["baseline-hybrid", "Hybrid (BM25+vector RRF)"],
];

// BrainRouter configs — any brainrouter-<config> present is shown. Known ones
// get a friendly label + preferred order; unknown ones fall back to their id.
const CONFIG_LABELS = {
  "brainrouter-keyword": "**BR: keyword (FTS only)**",
  "brainrouter-vector_rrf": "**BR: vector+FTS (RRF)**",
  "brainrouter-vector_mmr": "**BR: vector+MMR**",
  "brainrouter-reranker": "**BR: + reranker**",
  "brainrouter-judge": "**BR: + judge (top-20)**",
  "brainrouter-precision": "**BR: judge, top-5 (precision)**",
  "brainrouter-full": "**BR: full pipeline**",
  "brainrouter-recall": "**BR: judge off, top-20**",
  "brainrouter-memory": "**BrainRouter**",
};
const CONFIG_ORDER = Object.keys(CONFIG_LABELS);
const IGNORE_IDS = new Set(["dataset-resolver", "dataset-validator", "_load"]);

function configRowsFor(sys) {
  const ids = [...sys.keys()].filter((id) => id.startsWith("brainrouter-") && !IGNORE_IDS.has(id));
  ids.sort((a, b) => {
    const ia = CONFIG_ORDER.indexOf(a);
    const ib = CONFIG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return ids.map((id) => [id, CONFIG_LABELS[id] ?? `**${id}**`]);
}
const SPLIT_ORDER = ["membench:ps-fm:10k", "membench:ps-rm:10k", "membench:os-fm:10k", "membench:os-rm:10k"];
const SPLIT_DESC = {
  "membench:ps-fm:10k": "Participation · Factual",
  "membench:ps-rm:10k": "Participation · Reflective",
  "membench:os-fm:10k": "Observation · Factual",
  "membench:os-rm:10k": "Observation · Reflective",
};

function loadRuns() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .map((d) => path.join(ROOT, d, "summary.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, "utf8")))
    .filter((s) => s?.config?.suite === "retrieval");
}

// fixture -> systemId -> { result, queries }
function index(runs) {
  const byFixture = new Map();
  for (const run of runs) {
    const fixture = run.config.fixture;
    if (!byFixture.has(fixture)) byFixture.set(fixture, new Map());
    const sys = byFixture.get(fixture);
    for (const r of run.results) {
      if (r.systemId === "dataset-resolver" || r.systemId === "dataset-validator") continue;
      // keep the most informative copy (passed > anything; later run wins ties)
      const prev = sys.get(r.systemId);
      if (!prev || (prev.status !== "passed" && r.status === "passed")) {
        sys.set(r.systemId, r);
      }
    }
  }
  return byFixture;
}

const fmt = (x, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : "—");
const fmtMs = (x) => (typeof x === "number" && Number.isFinite(x) ? (x >= 100 ? Math.round(x) : x.toFixed(1)) : "—");

function bestOf(rows, key) {
  let best = -Infinity;
  for (const r of rows) {
    const v = r.result?.metrics?.[key];
    if (typeof v === "number" && v > best) best = v;
  }
  return best;
}

function table(sys) {
  const order = [...BASELINE_ROWS, ...configRowsFor(sys)];
  const rows = order.map(([id, label]) => ({ id, label, result: sys.get(id) })).filter((r) => r.result);
  const bestR10 = bestOf(rows, "recallAt10");
  const bestP5 = bestOf(rows, "precisionAt5");
  const bestNdcg = bestOf(rows, "ndcgAt10");
  const lines = [
    "| System | R@5 | R@10 | R@20 | P@5 | nDCG@10 | MRR | p50 ms | status |",
    "|---|--:|--:|--:|--:|--:|--:|--:|:--|",
  ];
  for (const { label, result } of rows) {
    const m = result.metrics ?? {};
    if (result.status !== "passed") {
      lines.push(`| ${label} | — | — | — | — | — | — | — | ${result.status}${result.unavailableReason ? ` (${result.unavailableReason})` : ""} |`);
      continue;
    }
    const mark = (v, best) => (typeof v === "number" && v === best && best > 0 ? `**${fmt(v)}**` : fmt(v));
    lines.push(
      `| ${label} | ${fmt(m.recallAt5)} | ${mark(m.recallAt10, bestR10)} | ${fmt(m.recallAt20)} | ${mark(m.precisionAt5, bestP5)} | ${mark(m.ndcgAt10, bestNdcg)} | ${fmt(m.mrr)} | ${fmtMs(m.p50Ms)} | passed |`,
    );
  }
  return lines.join("\n");
}

const runs = loadRuns();
const byFixture = index(runs);
const out = [];
out.push("# BrainRouter Memory — Comparison Report");
out.push("");
out.push(
  "BrainRouter vs. standard memory-retrieval strategies on the MemBench 10k splits " +
    "(each trajectory padded with ~10k tokens of distractor noise). Each system retrieves " +
    "up to 20 results; gold answers are matched by stable record id. Best value per quality " +
    "column is **bold**.",
);
out.push("");
out.push(
  "**Setup.** Bounded slice per split (`--max-records 3000 --max-queries 30`, seed 1337); same slice for every system. " +
    "Baselines run in-process. Each `BR:` row is the live BrainRouter MCP server (local `gemma-4-e2b`) under one pipeline " +
    "config from `envs/.env.benchmark_*` — keyword-only, vector+FTS (RRF), +MMR, +reranker, +judge, precision (judge top-5), " +
    "or full. Only the configs you actually ran appear below.",
);
out.push("");

const fixtures = [...SPLIT_ORDER.filter((f) => byFixture.has(f)), ...[...byFixture.keys()].filter((f) => !SPLIT_ORDER.includes(f))];
if (fixtures.length === 0) {
  out.push("_No retrieval runs found in results/memory/._");
}
for (const f of fixtures) {
  const sys = byFixture.get(f);
  const anyBaseline = sys.get("baseline-bm25") ?? [...sys.values()][0];
  const q = anyBaseline?.perQuery?.length ?? "?";
  out.push(`## ${f}${SPLIT_DESC[f] ? ` — ${SPLIT_DESC[f]}` : ""}`);
  out.push("");
  out.push(`_${q} queries scored over a bounded ~3000-record corpus (incl. distractor noise)._`);
  out.push("");
  out.push(table(sys));
  out.push("");
}

out.push("---");
out.push("");
out.push("### How to read this");
out.push("");
out.push(
  "- **R@k** rewards finding the gold record in the top-k; **P@5** rewards a clean top-5 (few false positives); " +
    "**nDCG@10 / MRR** reward ranking the gold high; **p50** is per-query latency.\n" +
    "- BrainRouter configs isolate one pipeline stage each: `keyword` (FTS), `vector_rrf` (+embeddings), `vector_mmr` " +
    "(+diversity), `reranker` (+cross-encoder), `judge` (+LLM judge, top-20), `precision` (judge, top-5), `full` (all on).\n" +
    "- Judge configs optimize precision (high P@5) at the cost of recall breadth and latency; non-judge configs are the raw " +
    "retriever (millisecond latency).\n" +
    "- Baselines: full-dump/capped-dump are lexical-overlap; vector is a 64-d hashed embedding (weak by design); hybrid is BM25+vector RRF.",
);
out.push("");
console.log(out.join("\n"));
