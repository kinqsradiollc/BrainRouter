// Builds a writeup-ready memory comparison report from the retrieval runs in
// results/memory/. Splits are grouped by what recall@k actually measures for
// them (factual / reflective / conversational); only the splits + configs you
// actually ran appear. One row per system (baselines + brainrouter-<config>).
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
  ["baseline-vector", "Vector (64-d hash baseline)"],
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

// If the best value in a quality column is below this, the column is
// uninformative (everything ≈0) — don't bold a "winner" among noise.
const NOISE_FLOOR = 0.05;

function configRowsFor(sys) {
  const ids = [...sys.keys()].filter((id) => id.startsWith("brainrouter-") && !IGNORE_IDS.has(id));
  ids.sort((a, b) => {
    const ia = CONFIG_ORDER.indexOf(a);
    const ib = CONFIG_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return ids.map((id) => [id, CONFIG_LABELS[id] ?? `**${id}**`]);
}

const SPLIT_DESC = {
  "membench:ps-fm:10k": "Participation · Factual",
  "membench:os-fm:10k": "Observation · Factual",
  "membench:ps-rm:10k": "Participation · Reflective",
  "membench:os-rm:10k": "Observation · Reflective",
  "longmemeval:s": "LongMemEval-S (sessions)",
  "locomo": "LoCoMo (turns)",
};
// Preferred split order within the whole report.
const SPLIT_ORDER = [
  "membench:ps-fm:10k", "membench:os-fm:10k",
  "membench:ps-rm:10k", "membench:os-rm:10k",
  "longmemeval:s", "locomo",
];

// Groups decide how to *read* a split's numbers, and carry the caveat.
const GROUPS = [
  {
    key: "factual",
    short: "Factual",
    title: "Factual retrieval — single gold record",
    match: (f) => /^membench:.*-fm:/.test(f),
    note: "Each question maps to one gold record, so recall@k is the right metric here. The full-context dump is roughly the recall ceiling for the slice.",
  },
  {
    key: "reflective",
    short: "Reflective",
    title: "Reflective / synthesis — multi-evidence",
    match: (f) => /^membench:.*-rm:/.test(f),
    note: "⚠️ Read as diagnostic, not a ranking. Scores are low for *every* system (including the full-context dump) because reflective questions share little surface signal with their gold evidence, and single-gold recall@k under-counts answers that synthesize many records. Gold records are always present in the slice (the sampler includes them first), so this is retrieval *hardness*, not a missing-data artifact.",
  },
  {
    key: "conversational",
    short: "Conversational",
    title: "Conversational memory — LoCoMo · LongMemEval",
    match: (f) => /^(longmemeval|locomo)/.test(f),
    note: "LongMemEval records are whole sessions, so `R-any@k` (did *any* gold session surface) is the headline; LoCoMo is turn-level recall@k.",
  },
];
const OTHER_GROUP = { key: "other", short: "Other", title: "Other", note: null };
function groupKeyFor(f) {
  return GROUPS.find((g) => g.match(f))?.key ?? "other";
}

function loadRuns() {
  if (!fs.existsSync(ROOT)) return [];
  return fs
    .readdirSync(ROOT)
    .map((d) => path.join(ROOT, d, "summary.json"))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(fs.readFileSync(p, "utf8")))
    .filter((s) => s?.config?.suite === "retrieval");
}

// fixture -> systemId -> result
function index(runs) {
  const byFixture = new Map();
  for (const run of runs) {
    const fixture = run.config.fixture;
    if (!byFixture.has(fixture)) byFixture.set(fixture, new Map());
    const sys = byFixture.get(fixture);
    for (const r of run.results) {
      if (r.systemId === "dataset-resolver" || r.systemId === "dataset-validator") continue;
      // Keep the most informative copy: passed beats non-passed, and among two
      // passed runs the NEWEST wins (by completedAt) — so re-running a config
      // overrides the older row instead of being ignored.
      const prev = sys.get(r.systemId);
      const newerPassed =
        prev && prev.status === "passed" && r.status === "passed" &&
        String(r.completedAt ?? "") > String(prev.completedAt ?? "");
      if (!prev || (prev.status !== "passed" && r.status === "passed") || newerPassed) {
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
  const best = {
    recallAt10: bestOf(rows, "recallAt10"),
    recallAnyAt5: bestOf(rows, "recallAnyAt5"),
    recallAnyAt10: bestOf(rows, "recallAnyAt10"),
    precisionAt5: bestOf(rows, "precisionAt5"),
    ndcgAt10: bestOf(rows, "ndcgAt10"),
  };
  const mark = (v, key) => {
    const b = best[key];
    return typeof v === "number" && v === b && b >= NOISE_FLOOR ? `**${fmt(v)}**` : fmt(v);
  };
  const lines = [
    "| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  const notes = [];
  for (const { label, result } of rows) {
    const m = result.metrics ?? {};
    if (result.status !== "passed") {
      lines.push(`| ${label} — _${result.status}_ | — | — | — | — | — | — | — | — | — |`);
      notes.push(`${label.replace(/\*\*/g, "")}: ${result.status}${result.unavailableReason ? ` — ${result.unavailableReason}` : ""}`);
      continue;
    }
    lines.push(
      `| ${label} | ${fmt(m.recallAt5)} | ${mark(m.recallAt10, "recallAt10")} | ${fmt(m.recallAt20)} | ${mark(m.recallAnyAt5, "recallAnyAt5")} | ${mark(m.recallAnyAt10, "recallAnyAt10")} | ${mark(m.precisionAt5, "precisionAt5")} | ${mark(m.ndcgAt10, "ndcgAt10")} | ${fmt(m.mrr)} | ${fmtMs(m.p50Ms)} |`,
    );
  }
  let block = lines.join("\n");
  if (notes.length) block += "\n\n" + notes.map((n) => `> ⚠ ${n}`).join("\n");
  return block;
}

const runs = loadRuns();
const byFixture = index(runs);
const fixtures = [
  ...SPLIT_ORDER.filter((f) => byFixture.has(f)),
  ...[...byFixture.keys()].filter((f) => !SPLIT_ORDER.includes(f)).sort(),
];

const out = [];
out.push("# BrainRouter Memory — Comparison Report");
out.push("");
out.push(
  "BrainRouter vs. standard memory-retrieval strategies on long-term-memory benchmarks. " +
    "Each system retrieves up to 20 results; gold answers are matched by stable record id. " +
    "Best value per quality column is **bold** (suppressed when the whole column is ≈0).",
);
out.push("");

const allGroups = [...GROUPS, OTHER_GROUP];
if (fixtures.length) {
  const covers = allGroups
    .map((g) => {
      const fs2 = fixtures.filter((f) => groupKeyFor(f) === g.key).map((f) => SPLIT_DESC[f] ?? f);
      return fs2.length ? `**${g.short}** (${fs2.join(", ")})` : null;
    })
    .filter(Boolean);
  out.push("_This run covers:_ " + covers.join(" · ") + ".");
  out.push("");
}

out.push(
  "**Setup.** Bounded slice per split (`--max-records`, `--max-queries`, seed 1337); the **same** slice for every " +
    "system, and the sampler always includes the gold records. Baselines run in-process. Each `BR:` row is the live " +
    "BrainRouter MCP server (local `gemma-4-e2b`, local vLLM reranker) under one pipeline config from `envs/.env.benchmark_*`.",
);
out.push("");

if (fixtures.length === 0) {
  out.push("_No retrieval runs found in results/memory/._");
}

for (const g of allGroups) {
  const groupFixtures = fixtures.filter((f) => groupKeyFor(f) === g.key);
  if (!groupFixtures.length) continue;
  out.push(`## ${g.title}`);
  out.push("");
  if (g.note) {
    out.push(`_${g.note}_`);
    out.push("");
  }
  for (const f of groupFixtures) {
    const sys = byFixture.get(f);
    const anyRow = sys.get("baseline-bm25") ?? [...sys.values()][0];
    const q = anyRow?.perQuery?.length ?? "?";
    out.push(`### ${f}${SPLIT_DESC[f] ? ` — ${SPLIT_DESC[f]}` : ""}`);
    out.push("");
    out.push(`_${q} queries · same bounded slice for every system (gold always included)._`);
    out.push("");
    out.push(table(sys));
    out.push("");
  }
}

out.push("---");
out.push("");
out.push("### How to read this");
out.push("");
out.push(
  [
    "- **R@k** = gold record in the top-k; **R-any@k** = *any* gold record surfaces (headline for session-level LongMemEval); **P@5** = a clean top-5; **nDCG@10 / MRR** reward ranking gold high; **p50** = per-query latency.",
    "- **Bold = best in that column**, suppressed when the column is all-noise so a near-zero \"winner\" isn't highlighted.",
    "- BrainRouter configs isolate one pipeline stage each: `keyword` (FTS), `vector_rrf` (+embeddings), `vector_mmr` (+diversity), `reranker` (+cross-encoder), `judge` (+LLM judge, top-20), `precision` (judge, top-5), `full` (all on).",
    "- **`keyword` ≡ `vector_rrf` ≡ `vector_mmr` is expected on lexically-findable corpora** — vector search returns the same records BM25 already found, so fusion/diversity add nothing until the queries are genuinely semantic.",
    "- **Latency is local-model-bound:** `reranker` / `judge` / `full` rows are dominated by the local LLM + reranker, not the retriever (the non-judge rows are millisecond-scale) — expect very different absolute numbers behind a hosted model.",
    "- Baselines: full-/capped-dump are lexical-overlap; **vector is a 64-d hashed embedding — a deliberately weak strawman, not BrainRouter's real embeddings**; hybrid is BM25+vector RRF.",
  ].join("\n"),
);
out.push("");
console.log(out.join("\n"));
