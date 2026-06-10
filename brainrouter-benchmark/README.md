# BrainRouter Benchmark

Measures BrainRouter's memory recall — **one pipeline stage at a time** — against the
standard baselines (full-context, recency, BM25, vector, hybrid) on **MemBench**,
**LoCoMo**, and **LongMemEval**.

**Run every command from this folder.** Runs are seeded (`1337`) and reproducible.
Output lands in `results/` (raw JSON) and `reports/` (Markdown).

---

## Quickstart (no external services)

```bash
npm run build
npm run bench:memory:retrieval -- --fixture tiny --progress
npm run bench:report
```

If that prints a table, the harness works. Everything below runs the **real** datasets
against a live BrainRouter server.

---

## What you need

| | |
|---|---|
| **Node ≥ 22** | deps are hoisted to the repo root — if `../node_modules` is missing, run `npm install` once at the root |
| **An LLM + embedding endpoint** | e.g. **LM Studio on `:1234`** with `google/gemma-4-e2b`. Base config is read from `../brainrouter/.env` |
| **(optional) a reranker** | a Cohere/vLLM `/v1/rerank` service (e.g. vLLM on `:8000`). LM Studio has none → the `reranker`/`full` configs report `unavailable` |
| **Port `3747` free** | the scripts start/stop the server here |

---

## Step 1 — Datasets (once)

```bash
# MemBench: fetch the upstream archive (drive id in datasets/membench.manifest.json)
mkdir -p datasets/raw/membench
gdown "<drive-id>" -O datasets/raw/membench/archive.zip
( cd datasets/raw/membench && unzip -q archive.zip )
npm run bench:datasets:build-split -- --split membench:ps-fm:10k    # repeat per split

# LoCoMo + LongMemEval: drop the raw files, then build
#   datasets/raw/locomo10.json   datasets/raw/longmemeval_s.json
npm run bench:datasets:build-locomo
npm run bench:datasets:build-longmemeval

npm run bench:datasets:list        # every split you built should say "yes"
```

| fixture | record unit | headline metric |
|---|---|---|
| `membench:{ps-fm,ps-rm,os-fm,os-rm}:{10k,100k}` | fact | recall@k · nDCG · MRR |
| `locomo` | turn | recall@k |
| `longmemeval:s` | session | **recall_any@k** |

---

## Step 2 — Pick the configs

Each pipeline mode is its own env file (`envs/.env.benchmark_<name>`) — a clone of
`../brainrouter/.env` with that mode's recall knobs pinned, so you can test each stage
in isolation.

```bash
./make-bench-envs.sh        # (re)generate all of them from your .env
```

| config | isolates |
|---|---|
| `keyword` | FTS / BM25 only (vectors off, no judge) |
| `vector_rrf` | FTS + vector, RRF fusion |
| `vector_mmr` | + MMR diversity |
| `reranker` | + cross-encoder reranker* |
| `judge` | + LLM relevance judge (top 20) |
| `precision` | judge on, top 5 (BrainRouter's default) |
| `full` | everything on |

\* Before each `reranker`/`full` run the script **probes** the endpoint; if it isn't a
real `/v1/rerank` service the config is logged as **`unavailable`** — never a silent RRF
fallback. Point it at a real one and regenerate:
`RERANKER_ENDPOINT=https://host/v1/rerank ./make-bench-envs.sh`.

Add your own mode by dropping a new `envs/.env.benchmark_<name>` — it's picked up
automatically. (These files hold copied API keys and are git-ignored.)

---

## Step 3 — Run

Two phases: **load once, then test.**

```bash
export BRAINROUTER_LLM_MAX_CONCURRENT=2                          # keep local models happy (see ⚠️)
export SPLITS="ps-fm ps-rm os-fm os-rm locomo longmemeval:s"     # all six; default is the 4 MemBench

./bench-load.sh        # import each split into its own throwaway DB + capture baselines
./bench-all.sh         # sweep every config across every split
                       #   …or one at a time:  ./bench-one.sh judge   ./bench-one.sh reranker ps-fm
```

Build the report:

```bash
node build-comparison-report.mjs > reports/memory-comparison.md
```

One clean table per split — baselines + every config you ran, best value per column in
**bold**. (`npm run bench:report` dumps every raw row instead, for auditing.)

**Scope it down while iterating** — defaults are `MAXREC=3000`, `MAXQ=30`:

```bash
SPLITS="ps-fm" MAXREC=1000 MAXQ=10 ./bench-load.sh
SPLITS="ps-fm" MAXREC=1000 MAXQ=10 ./bench-one.sh judge
```

> **Resumable.** Loading is the slow part and happens once per split; config runs reuse
> the loaded DBs. If a config dies, just re-run it — no reload.
>
> **Watch progress:** `tail -f /tmp/bench-load-<split>.log` (loading) or
> `tail -f /tmp/bench-<config>-<split>.log` (a config run).
>
> **Timing:** non-judge configs are seconds/split; judge configs are minutes/split. The
> full six-split sweep is a few hours (LongMemEval is slowest) — lower `MAXQ` or run it
> in two batches for a faster first pass.

> ⚠️ **Don't crank concurrency.** Pushing a single local model with many parallel
> embed/judge calls makes it drop connections (`LM Link connection closed`), which taints
> results and looks like a stall. Keep `BRAINROUTER_LLM_MAX_CONCURRENT` at `1`–`2`; the
> server retries the occasional drop automatically.

---

## Re-run from clean

```bash
lsof -ti :3747 | xargs kill        # stop any server
rm -f  ~/.brainrouter-bench/*      # throwaway DBs + keys
rm -rf results/memory/*            # old runs
rm -f  reports/memory-comparison.md
```

---

## Reference

**Knobs** (the scripts set the bench-side ones for you):

| env var | effect |
|---|---|
| `SPLITS` / `MAXREC` / `MAXQ` | which splits, corpus size, # queries |
| `BRAINROUTER_LLM_MAX_CONCURRENT` | parallel LLM/embed calls — keep at `1`–`2` for local models |
| `RERANKER_ENDPOINT` | bake a real `/v1/rerank` url into `reranker`/`full` (with `make-bench-envs.sh`) |
| `BRAINROUTER_RELEVANCE_JUDGE_ENABLED` | `true` = precision, `false` = recall |
| `BRAINROUTER_RECALL_TOP_RESULTS` / `_FTS_LIMIT` / `_VEC_LIMIT` | result count / candidate pool |
| `BRAINROUTER_RECALL_DIVERSITY` | `on` / `off` (MMR) |
| `BRAINROUTER_EMBEDDING_API_KEY` | empty = vectors off (keyword only) |
| `BRAINROUTER_BENCH_MCP_TIMEOUT_MS` | raise if judge runs hit `Request timed out` |

**Troubleshooting:**

| symptom | fix |
|---|---|
| `… not loaded — run ./bench-load.sh first` | run `./bench-load.sh` before testing |
| `reranker` shows `unavailable` | its `/v1/rerank` probe failed (LM Studio has none) — point at a real service + `./make-bench-envs.sh` |
| `MCP error … Request timed out` | raise `BRAINROUTER_BENCH_MCP_TIMEOUT_MS`, or use a non-judge config |
| `401` / `403` | stale key — re-run `./bench-load.sh` (re-mints per split) |
| `EADDRINUSE :3747` | `lsof -ti :3747 \| xargs kill` |
| identical numbers across configs | expected on tiny/easy slices — raise `MAXQ`, use real splits |
| few / low live hits | LM Studio down → keyword fallback. Check `curl localhost:1234/v1/models` |

> `tiny` is a smoke fixture — never use it for claims. `datasets/raw/**`,
> `datasets/membench/**`, and `envs/` are git-ignored.
