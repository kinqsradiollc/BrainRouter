# BrainRouter Benchmark

Compares BrainRouter's memory recall — **one pipeline config at a time** — against
the standard alternatives (full-context dump, recency cap, BM25, vector, hybrid)
on MemBench data.

- `src/memory/` — memory/retrieval comparison
- `src/cli/` — deterministic CLI checks

Runs are seeded (`1337`) and reproducible. Outputs → `results/` (raw JSON) and
`reports/` (Markdown). **Run every command from this folder.**

---

## Prerequisites

- **Node ≥ 22.** Deps are hoisted to the repo-root `node_modules` (workspace); if
  `../node_modules` is missing, run `npm install` once at the repo root.
- **Live BrainRouter rows:** an LLM/embedding endpoint, e.g. **LM Studio on
  `:1234`** with `google/gemma-4-e2b`. The base config is read from
  `../brainrouter/.env`.
- **MemBench data:** `gdown` + `python3`/`numpy` to fetch/convert the archive.

---

## 1. Smoke test (no external deps)

```bash
npm run build
npm run bench:datasets:list
npm run bench:memory:retrieval -- --fixture tiny --progress
npm run bench:report
```

---

## 2. Get the datasets (once)

```bash
npm run bench:datasets:import-membench          # small "github-simple" sample
# 10k/100k need the upstream archive (id in datasets/membench.manifest.json):
mkdir -p datasets/raw/membench
gdown "<google-drive-id>" -O datasets/raw/membench/archive.zip
cd datasets/raw/membench && unzip -q archive.zip && cd -
npm run bench:datasets:build-split -- --split membench:ps-fm:10k     # repeat per split
npm run bench:datasets:list                      # confirm "yes"
```

Splits: `membench:{ps-fm,ps-rm,os-fm,os-rm}:{10k,100k}` →
`First/Third AgentData {Low,High}Level.json`. `10k` adds 10 noise units/trajectory,
`100k` adds 100.

**LongMemEval-S** and **LoCoMo** (conversation-memory benchmarks). Place the raw
files under `datasets/raw/` then build:

```bash
# datasets/raw/longmemeval_s.json  and  datasets/raw/locomo10.json
npm run bench:datasets:build-longmemeval     # → fixture longmemeval:s (sessions; recall_any@k)
npm run bench:datasets:build-locomo          # → fixture locomo (turns; recall@k)
```

| fixture | unit (record) | gold | headline metric |
|---|---|---|---|
| `longmemeval:s` | session | `answer_session_ids` | **R-any@k** (recall_any) |
| `locomo` | turn | `evidence` turns | recall@k |

Both build a **global-union corpus**; the per-run haystack size is `--max-records`
(so it's tunable, and harder than the per-question haystack some papers report).

---

## 3. The config matrix (one `.env` per pipeline mode)

Each BrainRouter config is its own env file under `envs/.env.benchmark_<name>` —
a **clone of `../brainrouter/.env`** with that config's recall knobs pinned. This
is how you test each pipeline stage **individually** instead of one fixed combo.

```bash
./make-bench-envs.sh        # generates all envs/.env.benchmark_* from your .env
```

| config | what it isolates |
|---|---|
| `keyword` | FTS / keyword only (embeddings OFF), no judge |
| `vector_rrf` | FTS + vector, RRF fusion only |
| `vector_mmr` | + MMR diversity |
| `reranker` | + cross-encoder reranker¹ |
| `judge` | + LLM relevance judge, return up to 20 |
| `precision` | judge ON, top-5 (BrainRouter's default, precision-first) |
| `full` | everything on |

Files are git-ignored (they contain copied API keys). **Add your own**: drop a new
`envs/.env.benchmark_<name>` (or edit one) and it's picked up automatically.

¹ Reranker needs a Cohere/vLLM-compatible `/v1/rerank` endpoint. Before each
`reranker`/`full` run the script **probes** it; if it doesn't return a valid
rerank response (**LM Studio has no rerank API**), that config is recorded as
**`unavailable`** in the report — it is *not* silently benchmarked as an RRF
fallback. To actually test reranking, point it at a real service and regenerate:
`RERANKER_ENDPOINT=https://my-rerank/v1/rerank ./make-bench-envs.sh`.

---

## 4. Run it

Two steps. **Load once, then test each config.** Needs LM Studio up and port
`3747` free.

```bash
# (a) import each split ONCE into its own throwaway DB (also captures baselines)
./bench-load.sh

# (b) test ONE config across the splits  ← the individual test
./bench-one.sh keyword
./bench-one.sh judge
./bench-one.sh precision
# … run as many configs as you like, one at a time

# or sweep EVERY config in one go:
./bench-all.sh
```

Scope it down while iterating (env overrides):

```bash
SPLITS="ps-fm" MAXREC=1000 MAXQ=10 ./bench-load.sh
SPLITS="ps-fm" MAXREC=1000 MAXQ=10 ./bench-one.sh judge
./bench-one.sh reranker ps-fm                 # one config, one split
SPLITS="longmemeval:s locomo" ./bench-load.sh && ./bench-one.sh judge longmemeval:s
```

Split tokens: the four MemBench ones (`ps-fm ps-rm os-fm os-rm`, → `membench:<x>:10k`),
plus `longmemeval:s` and `locomo`. Defaults: `SPLITS="ps-fm ps-rm os-fm os-rm"`,
`MAXREC=3000`, `MAXQ=30`.

**Verbose output**: every run prints the config's active knobs, the server's stage
readiness, per-query progress, and the resulting metrics inline (`→ brainrouter-<config> R@5=… p50=…`), so you see exactly what's running.

> Timing: non-judge configs are seconds/split; judge configs are ~minutes/split
> (local LLM per query). A full `bench-all.sh` over 4 splits is roughly 30–60 min.

---

## 5. Extract the report

```bash
node build-comparison-report.mjs > reports/memory-comparison.md
```

One clean table per split — baselines + every `brainrouter-<config>` you ran, best
value per quality column **bold**. (`npm run bench:report` instead dumps *every*
raw run row; use that to audit.)

---

## 6. Knobs

| env var | side | effect |
|---|---|---|
| `SPLITS` / `MAXREC` / `MAXQ` | scripts | which splits, corpus size, # queries |
| `RERANKER_ENDPOINT` | make-bench-envs | bake a real `/v1/rerank` url into reranker/full |
| `BRAINROUTER_MEMORY_DB` | server | SQLite path (scripts set a throwaway path per split) |
| `BRAINROUTER_RELEVANCE_JUDGE_ENABLED` | server | `true`=precision, `false`=recall |
| `BRAINROUTER_RECALL_TOP_RESULTS` / `_FTS_LIMIT` / `_VEC_LIMIT` | server | result count / candidate pool |
| `BRAINROUTER_RECALL_DIVERSITY` | server | `on`/`off` (MMR) |
| `BRAINROUTER_EMBEDDING_API_KEY` | server | empty = vector OFF (keyword only) |
| `BRAINROUTER_BENCH_MCP_URL` / `_API_KEY` | bench | point the adapter at the server |
| `BRAINROUTER_BENCH_SYSTEM_ID` | bench | row name in results (scripts set `brainrouter-<config>`) |
| `BRAINROUTER_BENCH_SKIP_IMPORT=1` | bench | query a pre-loaded DB (scripts use this) |

The scripts set the bench-side vars for you — the table is for manual runs /
custom configs.

---

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `… not loaded — run ./bench-load.sh first` | Run `./bench-load.sh` before `./bench-one.sh`. |
| reranker shows `unavailable` in the report | Its endpoint failed the pre-flight rerank probe (LM Studio has no `/v1/rerank`). That's intentional — set `RERANKER_ENDPOINT` to a real service + `./make-bench-envs.sh`, then re-run `./bench-one.sh reranker`. |
| `MCP error … Request timed out` | Raise `BRAINROUTER_BENCH_MCP_TIMEOUT_MS`, or use a non-judge config. |
| `401` / `403` | Stale key — re-run `./bench-load.sh` (re-mints into the split DB). |
| `EADDRINUSE :3747` | `lsof -ti :3747 \| xargs kill` |
| all configs give identical numbers | Expected on tiny/easy slices; raise `MAXQ` and use the real splits. |
| few/low live hits | LM Studio down → keyword fallback. Check `curl localhost:1234/v1/models`. |

---

## 8. Cleanup

```bash
lsof -ti :3747 | xargs kill            # stop any server
rm -f ~/.brainrouter-bench/*           # throwaway DBs + keys
rm -rf results/memory/*                # old runs
```

Notes: `tiny` is a smoke fixture — never use it for claims. Everything under
`datasets/raw/**`, `datasets/membench/**`, and `envs/` is git-ignored.
