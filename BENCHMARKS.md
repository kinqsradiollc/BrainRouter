# BrainRouter — Benchmarks

Public, reproducible proof for the "memory-native" claims. Every number below
comes from a committed result set under
[`brainrouter/benchmark/results/`](brainrouter/benchmark/results/) — this page
consolidates them into one comparison-grade view. Where a row compares against
"built-in memory," that means the file-dump strategies used by common coding
agents (a `CLAUDE.md` / `.cursorrules` / `memory-bank` loaded wholesale into the
prompt), not a tuned external retriever.

| Suite | Date | Platform | Commit | Raw data |
|---|---|---|---|---|
| Retrieval / scale / load / e2e / real-embeddings | 2026-05-17 | darwin arm64, Node 22.16 | `864751d` | [`results/2026-05-17/1/`](brainrouter/benchmark/results/2026-05-17/1/) |
| Code-recall (symbol isolation) | 2026-05-31 | darwin arm64, Node 22.16 | — | [`results/2026-05-31/`](brainrouter/benchmark/results/2026-05-31/) |

Headlines (full detail in each section):

- **Retrieval quality** — Recall@10 **0.986–0.990** on LongMemEval-S (500
  questions); the FTS lexical stage already hits 0.990 Recall@10.
- **Code-recall** — **100%** symbol isolation at **1.13** chunks/symbol over
  the TS/Python/Rust fixtures.
- **Context efficiency** — top-10 recall holds a **~450-token** budget at any
  corpus size; built-in dumps reach **2.2M tokens** at 50k observations
  (**100% token savings**, and 80–100% of that history is unreachable anyway).
- **End-to-end** — **95.1%** fewer prompt tokens and **73% faster** responses
  vs. a full workspace dump, at near-parity judged accuracy.

---

## 1. Retrieval quality — LongMemEval-S (500 questions)

Three pipelines: FTS-only (SQLite FTS5), Hybrid (BM25 + dense vectors via
Reciprocal Rank Fusion), and Hybrid + cross-encoder rerank.

| Pipeline | Recall@5 | Recall@10 | Recall@20 | NDCG@10 | MRR |
|---|---:|---:|---:|---:|---:|
| FTS-only | **0.970** | 0.990 | 0.996 | 0.8989 | 0.9138 |
| Hybrid (RRF) | 0.966 | 0.986 | **0.998** | **0.9068** | **0.9209** |
| Hybrid + rerank | 0.948 | 0.990 | **0.998** | 0.8862 | 0.8860 |

**Finding:** a general-purpose cross-encoder reranker *degrades* Recall@5
(0.970 → 0.948) on identifier-heavy developer memories (exact var names, config
keys, IDs) by smoothing exact matches into semantically-near-but-wrong ones.
Hybrid wins on multi-session and preference tracing where terms drift; FTS wins
on exact keyword recall. BrainRouter keeps rerank as an opt-in Stage 3.

Raw: [`longmemeval_fts.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_fts.json) ·
[`longmemeval_hybrid.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_hybrid.json) ·
[`longmemeval_hybrid+rerank.json`](brainrouter/benchmark/results/2026-05-17/1/longmemeval_hybrid+rerank.json)

Regenerate:

```bash
cd brainrouter
npm run bench:longmemeval          # FTS mode
npm run bench:longmemeval:hybrid   # hybrid mode
npm run bench:summary -- benchmark/results/<dir>   # comparison table + thresholds
```

## 2. Code-recall — chunk symbol isolation (new in 0.4.x)

Measures whether the code chunker isolates the right top-level symbols as their
own labelled chunks — the metric the codegraph-style tools don't publish.

| Metric | Value |
|---|---:|
| Samples (TS / Python / Rust) | 3 |
| Expected symbols | 8 |
| Isolated symbols | 8 |
| **Symbol recall** | **100.0%** |
| Chunks per isolated symbol (1.0 ideal) | 1.13 |

Raw: [`2026-05-31/code-recall.json`](brainrouter/benchmark/results/2026-05-31/code-recall.json).
Reproduce:

```bash
npx tsx -e "import {benchmarkCodeChunking, DEFAULT_CODE_SAMPLES, formatCodeRecallMd} from './brainrouter/src/memory/bench/code-recall.ts'; console.log(formatCodeRecallMd(benchmarkCodeChunking(DEFAULT_CODE_SAMPLES)))"
```

## 3. Scale & context efficiency

Built-in memory loads *all* history every session; BrainRouter retrieves only
the top-10, holding a fixed token budget as the corpus grows.

| Observations | Index build | FTS5 search | Hybrid search | Disk | Built-in ctx tokens | BrainRouter ctx tokens | Savings | Built-in unreachable |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 240 | 60ms | 0.235ms | 0.486ms | 4 KB | 10,504 | 450 | 96% | 17% |
| 1,000 | 405ms | 0.322ms | 1.002ms | 4.3 MB | 43,834 | 450 | 99% | 80% |
| 5,000 | 6.4s | 0.861ms | 3.799ms | 20.6 MB | 220,335 | 450 | 100% | 96% |
| 10,000 | 25.7s | 1.735ms | 9.693ms | 41.0 MB | 440,973 | 450 | 100% | 98% |
| 50,000 | 678.6s | 6.493ms | 39.708ms | 203.1 MB | 2,216,173 | 450 | 100% | 100% |

Cross-session retrieval (12 target queries, up to 29 sessions back): FTS **12/12
at rank #1**, Hybrid **12/12 at rank #1**, built-in (200-line cap) only **10/12**.

Raw: [`SCALE.md`](brainrouter/benchmark/results/2026-05-17/1/SCALE.md). Regenerate
with `npm run bench:scale`.

## 4. Load & concurrency (in-process SQLite)

Zero write failures across every cell, up to 100k records at C=100.

| Scale (N) | C | Op | Throughput | p50 | p99 | Errors |
|---:|---:|---|---:|---:|---:|---:|
| 1,000 | 1 | hybridSearch | 401 ops/s | 2.42ms | 3.26ms | 0 |
| 1,000 | 100 | hybridSearch | 319 ops/s | 307.2ms | 324.4ms | 0 |
| 10,000 | 1 | hybridSearch | 49 ops/s | 19.8ms | 32.3ms | 0 |
| 100,000 | 1 | hybridSearch | 5 ops/s | 194.6ms | 244.7ms | 0 |
| 100,000 | 1 | upsertL1 | 31 ops/s | 31.5ms | 41.5ms | 0 |

Raw: [`load-100k-864751d.json`](brainrouter/benchmark/results/2026-05-17/1/load-100k-864751d.json).
Regenerate with `npm run bench:load`.

## 5. Real embeddings — quality matrix

768-dim dense vectors over a 240-observation synthetic project (20 labelled
queries), comparing built-in dump strategies against BrainRouter modes.

| Configuration | Recall@5 | Recall@10 | Precision@5 | NDCG@10 | Latency | Tokens/query |
|---|---:|---:|---:|---:|---:|---:|
| Built-in (workspace grep) | 37.0% | 55.8% | 78.0% | 80.3% | 0.5ms | 22,610 |
| Built-in (truncated MEMORY.md) | 27.4% | 37.8% | 63.0% | 56.4% | 0.2ms | 7,938 |
| BrainRouter FTS5 | 42.3% | 61.4% | 95.0% | 91.5% | 0.4ms | 450 |
| BrainRouter Hybrid (RRF) | 42.3% | 60.9% | 95.0% | 90.8% | 1.2ms | 450 |
| Hybrid + decay + skill boost | 36.5% | **62.1%** | 85.0% | 87.7% | 1.4ms | 450 |
| + Stage 3 reranker | 42.3% | 59.6% | 95.0% | 89.7% | 179.8ms | 450 |

Raw: [`REAL-EMBEDDINGS.md`](brainrouter/benchmark/results/2026-05-17/1/REAL-EMBEDDINGS.md) ·
[`QUALITY.md`](brainrouter/benchmark/results/2026-05-17/1/QUALITY.md). Regenerate
with `npm run bench:real-embeddings` / `npm run bench:quality`.

## 6. End-to-end generative lift

Local model (`gemma`-class), full workspace dump vs. BrainRouter RAG over the
same 5 queries.

| Metric | Baseline (dump) | BrainRouter | Lift |
|---|---:|---:|---|
| LLM-as-judge (1–5) | 3.8 | 3.4 | −10.5% (near-parity, far less noise) |
| Request latency | 9,430ms | 2,545ms | **73.0% faster** |
| Prompt tokens | 14,767 | 717 | **95.1% fewer** |
| Output speed | 91.6 tok/s | 109.2 tok/s | 1.2× |

Raw: [`END-TO-END.md`](brainrouter/benchmark/results/2026-05-17/1/END-TO-END.md).
Regenerate with `npm run bench:e2e`.

---

## Reproducing the full overnight suite

```bash
cd brainrouter
npm run bench:overnight     # scale + quality + real-embeddings + load + e2e → results/<date>/
npm run bench:summary -- benchmark/results/<date>/<run>   # regression gate
```

Results write to `brainrouter/benchmark/results/<date>/<run>/`. The committed
sets above are the reference runs; re-run on your hardware to compare. Embedding
and end-to-end suites need an OpenAI-compatible endpoint (local LM Studio /
Ollama work); retrieval, scale, load, and code-recall run fully offline.
