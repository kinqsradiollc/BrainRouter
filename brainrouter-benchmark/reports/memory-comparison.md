# BrainRouter Memory — Comparison Report

BrainRouter vs. standard memory-retrieval strategies on long-term-memory benchmarks. Each system retrieves up to 20 results; gold answers are matched by stable record id. Best value per quality column is **bold** (suppressed when the whole column is ≈0).

_This run covers:_ **Factual** (Participation · Factual, Observation · Factual) · **Reflective** (Participation · Reflective, Observation · Reflective) · **Conversational** (LongMemEval-S (sessions), LoCoMo (turns)).

**Setup.** Bounded slice per split (`--max-records`, `--max-queries`, seed 1337); the **same** slice for every system, and the sampler always includes the gold records. Baselines run in-process. Each `BR:` row is the live BrainRouter MCP server (local `gemma-4-e2b`, local vLLM reranker) under one pipeline config from `envs/.env.benchmark_*`.

## Factual retrieval — single gold record

_Each question maps to one gold record, so recall@k is the right metric here. The full-context dump is roughly the recall ceiling for the slice._

### membench:ps-fm:10k — Participation · Factual

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.57 | 0.63 | 0.67 | 0.57 | 0.63 | 0.11 | 0.43 | 0.37 | 0.8 |
| Capped dump (recency 200) | 0.73 | 0.80 | 0.87 | 0.73 | 0.80 | 0.15 | 0.60 | 0.54 | 0.1 |
| BM25 (lexical) | 0.73 | 0.73 | 0.83 | 0.73 | 0.73 | 0.15 | 0.56 | 0.51 | 0.6 |
| Vector (64-d hash baseline) | 0.07 | 0.20 | 0.27 | 0.07 | 0.20 | 0.01 | 0.08 | 0.05 | 0.8 |
| Hybrid (BM25+vector RRF) | 0.50 | 0.57 | 0.77 | 0.50 | 0.57 | 0.10 | 0.37 | 0.32 | 1.5 |
| **BR: keyword (FTS only)** | 0.83 | 0.83 | 0.93 | 0.83 | 0.83 | 0.17 | 0.70 | 0.66 | 8.2 |
| **BR: vector+FTS (RRF)** | 0.83 | 0.83 | 0.93 | 0.83 | 0.83 | 0.17 | 0.70 | 0.66 | 50.6 |
| **BR: vector+MMR** | 0.83 | 0.83 | 0.93 | 0.83 | 0.83 | 0.17 | 0.70 | 0.66 | 52.1 |
| **BR: + reranker** | 0.97 | **0.97** | 0.97 | **0.97** | **0.97** | **0.19** | 0.76 | 0.69 | 7903 |
| **BR: + judge (top-20)** | 0.83 | 0.83 | 0.93 | 0.83 | 0.83 | 0.17 | 0.71 | 0.67 | 6117 |
| **BR: judge, top-5 (precision)** | 0.83 | 0.83 | 0.83 | 0.83 | 0.83 | 0.17 | 0.71 | 0.66 | 4036 |
| **BR: full pipeline** | 0.97 | **0.97** | 0.97 | **0.97** | **0.97** | **0.19** | **0.76** | 0.69 | 13812 |

### membench:os-fm:10k — Observation · Factual

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.60 | 0.63 | 0.67 | 0.60 | 0.63 | 0.12 | 0.49 | 0.45 | 1.3 |
| Capped dump (recency 200) | 0.80 | 0.80 | 0.83 | **0.80** | 0.80 | **0.16** | **0.69** | 0.66 | 0.1 |
| BM25 (lexical) | 0.67 | 0.90 | 0.97 | 0.67 | 0.90 | 0.13 | 0.52 | 0.41 | 0.7 |
| Vector (64-d hash baseline) | 0.20 | 0.23 | 0.40 | 0.20 | 0.23 | 0.04 | 0.15 | 0.14 | 0.9 |
| Hybrid (BM25+vector RRF) | 0.60 | 0.70 | 0.93 | 0.60 | 0.70 | 0.12 | 0.39 | 0.31 | 1.7 |
| **BR: keyword (FTS only)** | 0.67 | 0.87 | 1.00 | 0.67 | 0.87 | 0.13 | 0.55 | 0.46 | 11.4 |
| **BR: vector+FTS (RRF)** | 0.67 | 0.87 | 1.00 | 0.67 | 0.87 | 0.13 | 0.55 | 0.46 | 61.5 |
| **BR: vector+MMR** | 0.67 | 0.87 | 1.00 | 0.67 | 0.87 | 0.13 | 0.55 | 0.46 | 56.8 |
| **BR: + reranker** | 0.67 | **0.97** | 1.00 | 0.67 | **0.97** | 0.13 | 0.51 | 0.37 | 4795 |
| **BR: + judge (top-20)** | 0.67 | 0.87 | 1.00 | 0.67 | 0.87 | 0.13 | 0.55 | 0.46 | 6081 |
| **BR: judge, top-5 (precision)** | 0.67 | 0.67 | 0.67 | 0.67 | 0.67 | 0.13 | 0.49 | 0.42 | 3288 |
| **BR: full pipeline** | 0.70 | **0.97** | 1.00 | 0.70 | **0.97** | 0.14 | 0.53 | 0.39 | 10737 |

## Reflective / synthesis — multi-evidence

_⚠️ Read as diagnostic, not a ranking. Scores are low for *every* system (including the full-context dump) because reflective questions share little surface signal with their gold evidence, and single-gold recall@k under-counts answers that synthesize many records. Gold records are always present in the slice (the sampler includes them first), so this is retrieval *hardness*, not a missing-data artifact._

### membench:ps-rm:10k — Participation · Reflective

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.04 | 0.11 | 0.16 | 0.10 | 0.23 | 0.02 | 0.05 | 0.06 | 1.7 |
| Capped dump (recency 200) | 0.07 | **0.14** | 0.24 | **0.17** | **0.30** | 0.03 | **0.08** | 0.11 | 0.1 |
| BM25 (lexical) | 0.01 | 0.01 | 0.03 | 0.03 | 0.03 | 0.01 | 0.01 | 0.01 | 0.8 |
| Vector (64-d hash baseline) | 0.00 | 0.01 | 0.02 | 0.00 | 0.03 | 0.00 | 0.00 | 0.01 | 0.8 |
| Hybrid (BM25+vector RRF) | 0.00 | 0.00 | 0.02 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 1.8 |
| **BR: keyword (FTS only)** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 10.5 |
| **BR: vector+FTS (RRF)** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 53.6 |
| **BR: vector+MMR** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 58.0 |
| **BR: + reranker** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 61.5 |
| **BR: + judge (top-20)** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 6441 |
| **BR: judge, top-5 (precision)** | 0.06 | 0.06 | 0.06 | **0.17** | 0.17 | 0.03 | 0.04 | 0.06 | 4137 |
| **BR: full pipeline** | 0.06 | 0.06 | 0.11 | **0.17** | 0.17 | 0.03 | 0.04 | 0.07 | 6428 |

### membench:os-rm:10k — Observation · Reflective

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.01 | 0.01 | 0.03 | 0.03 | 0.03 | 0.01 | 0.01 | 0.04 | 1.8 |
| Capped dump (recency 200) | 0.12 | 0.22 | 0.34 | 0.27 | 0.47 | 0.08 | 0.16 | 0.20 | 0.1 |
| BM25 (lexical) | 0.04 | 0.04 | 0.04 | 0.07 | 0.07 | 0.03 | 0.04 | 0.04 | 1.0 |
| Vector (64-d hash baseline) | 0.00 | 0.00 | 0.01 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.9 |
| Hybrid (BM25+vector RRF) | 0.04 | 0.05 | 0.05 | 0.07 | 0.10 | 0.03 | 0.05 | 0.05 | 1.8 |
| **BR: keyword (FTS only)** | 0.36 | **0.49** | 0.58 | **0.73** | **0.87** | 0.23 | 0.44 | 0.63 | 13.1 |
| **BR: vector+FTS (RRF)** | 0.36 | **0.49** | 0.58 | **0.73** | **0.87** | 0.23 | 0.44 | 0.63 | 59.0 |
| **BR: vector+MMR** | 0.36 | **0.49** | 0.58 | **0.73** | **0.87** | 0.23 | 0.44 | 0.63 | 58.9 |
| **BR: + reranker** | 0.36 | **0.49** | 0.58 | **0.73** | **0.87** | 0.23 | 0.44 | 0.63 | 61.7 |
| **BR: + judge (top-20)** | 0.39 | **0.49** | 0.58 | **0.73** | **0.87** | **0.25** | 0.45 | 0.64 | 6435 |
| **BR: judge, top-5 (precision)** | 0.36 | 0.36 | 0.36 | **0.73** | 0.73 | 0.23 | 0.40 | 0.62 | 4897 |
| **BR: full pipeline** | 0.39 | **0.49** | 0.58 | **0.73** | **0.87** | **0.25** | **0.45** | 0.64 | 6583 |

## Conversational memory — LoCoMo · LongMemEval

_LongMemEval records are whole sessions, so `R-any@k` (did *any* gold session surface) is the headline; LoCoMo is turn-level recall@k._

### longmemeval:s — LongMemEval-S (sessions)

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.77 | 0.83 | 0.87 | 0.77 | 0.83 | 0.15 | 0.70 | 0.66 | 2.8 |
| Capped dump (recency 200) | 0.93 | **0.93** | 0.97 | **0.93** | **0.93** | 0.19 | **0.84** | 0.81 | 0.1 |
| BM25 (lexical) | 0.77 | 0.83 | 0.87 | 0.77 | 0.83 | 0.15 | 0.59 | 0.51 | 0.7 |
| Vector (64-d hash baseline) | 0.03 | 0.03 | 0.03 | 0.03 | 0.03 | 0.01 | 0.03 | 0.03 | 0.8 |
| Hybrid (BM25+vector RRF) | 0.63 | 0.80 | 0.87 | 0.63 | 0.80 | 0.13 | 0.50 | 0.41 | 1.8 |
| **BR: keyword (FTS only)** | 0.73 | 0.87 | 0.90 | 0.73 | 0.87 | 0.15 | 0.60 | 0.52 | 40.2 |
| **BR: vector+FTS (RRF)** | 0.73 | 0.87 | 0.90 | 0.73 | 0.87 | 0.15 | 0.60 | 0.52 | 117 |
| **BR: vector+MMR** | 0.73 | 0.87 | 0.90 | 0.73 | 0.87 | 0.15 | 0.60 | 0.52 | 118 |
| **BR: + reranker** | 0.87 | 0.90 | 0.90 | 0.87 | 0.90 | 0.17 | 0.76 | 0.71 | 14455 |
| **BR: + judge (top-20)** | 0.73 | 0.87 | 0.90 | 0.73 | 0.87 | 0.15 | 0.62 | 0.55 | 5666 |
| **BR: judge, top-5 (precision)** | 0.70 | 0.70 | 0.70 | 0.70 | 0.70 | **0.19** | 0.60 | 0.56 | 4535 |
| **BR: full pipeline** | 0.87 | 0.90 | 0.90 | 0.87 | 0.90 | 0.17 | 0.75 | 0.70 | 20294 |

### locomo — LoCoMo (turns)

_30 queries · same bounded slice for every system (gold always included)._

| System | R@5 | R@10 | R@20 | R-any@5 | R-any@10 | P@5 | nDCG@10 | MRR | p50 ms |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| Full-context dump | 0.52 | 0.60 | 0.65 | 0.57 | 0.63 | 0.12 | 0.47 | 0.44 | 0.8 |
| Capped dump (recency 200) | 0.62 | 0.67 | 0.69 | 0.67 | 0.70 | 0.15 | 0.51 | 0.48 | 0.1 |
| BM25 (lexical) | 0.37 | 0.45 | 0.49 | 0.37 | 0.47 | 0.07 | 0.35 | 0.32 | 0.5 |
| Vector (64-d hash baseline) | 0.03 | 0.07 | 0.12 | 0.03 | 0.07 | 0.01 | 0.03 | 0.02 | 0.8 |
| Hybrid (BM25+vector RRF) | 0.25 | 0.38 | 0.45 | 0.27 | 0.40 | 0.05 | 0.24 | 0.20 | 1.4 |
| **BR: keyword (FTS only)** | 0.37 | 0.48 | 0.51 | 0.37 | 0.50 | 0.07 | 0.36 | 0.33 | 5.3 |
| **BR: vector+FTS (RRF)** | 0.37 | 0.48 | 0.51 | 0.37 | 0.50 | 0.07 | 0.36 | 0.33 | 37.1 |
| **BR: vector+MMR** | 0.37 | 0.48 | 0.51 | 0.37 | 0.50 | 0.07 | 0.36 | 0.33 | 43.8 |
| **BR: + reranker** | 0.75 | **0.78** | 0.78 | **0.83** | **0.90** | **0.19** | **0.71** | 0.73 | 6065 |
| **BR: + judge (top-20)** | 0.42 | 0.48 | 0.51 | 0.43 | 0.50 | 0.09 | 0.40 | 0.39 | 5443 |
| **BR: judge, top-5 (precision)** | 0.37 | 0.37 | 0.37 | 0.37 | 0.37 | 0.07 | 0.35 | 0.35 | 3894 |
| **BR: full pipeline** | 0.75 | **0.78** | 0.78 | **0.83** | **0.90** | **0.19** | 0.70 | 0.71 | 12396 |

---

### How to read this

- **R@k** = gold record in the top-k; **R-any@k** = *any* gold record surfaces (headline for session-level LongMemEval); **P@5** = a clean top-5; **nDCG@10 / MRR** reward ranking gold high; **p50** = per-query latency.
- **Bold = best in that column**, suppressed when the column is all-noise so a near-zero "winner" isn't highlighted.
- BrainRouter configs isolate one pipeline stage each: `keyword` (FTS), `vector_rrf` (+embeddings), `vector_mmr` (+diversity), `reranker` (+cross-encoder), `judge` (+LLM judge, top-20), `precision` (judge, top-5), `full` (all on).
- **`keyword` ≡ `vector_rrf` ≡ `vector_mmr` is expected on lexically-findable corpora** — vector search returns the same records BM25 already found, so fusion/diversity add nothing until the queries are genuinely semantic.
- **Latency is local-model-bound:** `reranker` / `judge` / `full` rows are dominated by the local LLM + reranker, not the retriever (the non-judge rows are millisecond-scale) — expect very different absolute numbers behind a hosted model.
- Baselines: full-/capped-dump are lexical-overlap; **vector is a 64-d hashed embedding — a deliberately weak strawman, not BrainRouter's real embeddings**; hybrid is BM25+vector RRF.

