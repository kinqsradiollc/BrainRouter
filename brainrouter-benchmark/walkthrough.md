# Benchmark run + MemBench 10k/100k import — walkthrough

## What was done

1. **Ran the benchmark end-to-end.** All self-contained suites pass on Node 22:
   `datasets:list`, `memory:dry-run`, `memory:retrieval` (baselines), `memory:load`,
   `cli:dry-run`, `cli:deterministic`, and `report`.

2. **Live BrainRouter memory adapter.** Started an isolated MCP server
   (`--http --port 3747`) against a throwaway DB (`~/.brainrouter-bench/memory.db`,
   minted via `npm run setup:admin`) so benchmark records never touch the real
   store. Pointed the LLM + relevance judge at `google/gemma-4-e2b` (LM Studio).
   Scored BrainRouter vs baselines on the real `membench:ps-fm:github-simple`
   split (bounded 200 records / 20 queries).

   | System | R@5 | nDCG@10 | MRR | P@5 |
   |---|---|---|---|---|
   | baseline-bm25 | 0.95 | 0.86 | 0.81 | 0.19 |
   | **brainrouter-memory** | **1.00** | **0.98** | **0.97** | **0.81** |

   BrainRouter's precision\@5 (0.81 vs ≤0.19) is the standout — the judge strips
   false positives. Cost is latency: ~11s p50/query on the local judge.

3. **Imported the MemBench 10k splits.** Downloaded the upstream archive (169 MB,
   gdown), unpacked `Membenchdata/data/*.json`, and wrote a converter
   (`src/shared/membench-data-importer.ts`) that:
   - flattens participation (session) and observation (message) trajectories,
   - resolves gold by stable `sid`/`mid` (session-disambiguated) — robust to noise,
   - interleaves distractor noise units (≈1k tokens each) to hit the length bucket,
   - is deterministic (seeded) and validated (3 unit tests, all green).

   Converted all four **10k** splits (`ps-fm`, `ps-rm`, `os-fm`, `os-rm`).
   Baselines on the real `ps-fm:10k` (226k records incl. 48k noise) score low
   (BM25 R@10 0.18, vector 0.01) — expected: naive retrieval drowns in noise.

## Files changed (committable)

- `src/shared/membench-data-importer.ts` — new converter + `buildMemBenchSplit`.
- `src/shared/membench-data-importer.test.ts` — unit tests.
- `src/memory/peer-adapters.ts` — configurable MCP call timeout
  (`BRAINROUTER_BENCH_MCP_TIMEOUT_MS`, default 300s) so a local-LLM-backed
  BrainRouter doesn't hit the SDK's 60s default.
- `src/index.ts` — `datasets:build-split` command.
- `package.json` — `bench:datasets:build-split` script.
- `README.md` — 10k/100k import docs.

Large data under `datasets/raw/**` and `datasets/membench/**` is git-ignored.

## How to reproduce / extend

```bash
# (re)build a split
npm run bench:datasets:build-split -- --split membench:ps-fm:10k
# the 100k variants are ~10x larger — generate on demand
npm run bench:datasets:build-split -- --split membench:ps-fm:100k

# baselines on a real split (large heap for big splits)
NODE_OPTIONS=--max-old-space-size=8192 \
  node dist/index.js memory:retrieval --fixture membench:ps-fm:10k --max-queries 100 --progress

# live BrainRouter (start an isolated server first):
BRAINROUTER_MEMORY_DB=~/.brainrouter-bench/memory.db \
BRAINROUTER_LLM_MODEL=google/gemma-4-e2b BRAINROUTER_RELEVANCE_JUDGE_MODEL=google/gemma-4-e2b \
  node ../brainrouter/dist/index.js --http --port 3747
BRAINROUTER_BENCH_MCP_URL=http://127.0.0.1:3747/mcp BRAINROUTER_BENCH_API_KEY=br_... \
  node dist/index.js memory:retrieval --fixture membench:ps-fm:10k --max-records 200 --max-queries 20 --progress
```

## Live BrainRouter on the noised ps-fm:10k (3000 rec / 20 q)

Two configs, same slice, vs baselines (best baseline shown for reference):

| Config | R@5 | R@20 | P@5 | nDCG | p50 |
|---|---|---|---|---|---|
| baseline-bm25 | 0.85 | 0.90 | 0.17 | 0.67 | 1 ms |
| baseline-capped-dump | 0.90 | 0.95 | 0.18 | 0.74 | 0 ms |
| **BrainRouter — judge ON, top-5** | 0.85 | 0.85¹ | **0.43** | 0.71 | 10.8 s |
| **BrainRouter — judge OFF, top-20** | 0.85 | **0.95** | 0.17 | 0.70 | 24 ms |

¹ Recall saturates because the full pipeline returns ≤5 results (often 1–3) —
`BRAINROUTER_RECALL_TOP_RESULTS=5` + the relevance judge trimming. So recall@10/20
can't exceed the top-5 capture.

Takeaways for tuning:
- The judge is a **precision/latency vs recall** lever: ON → P@5 0.43 (~2.4×
  baselines) but recall capped + ~10.8 s/query; OFF → recall@20 0.95 (ties the
  best baseline) at 24 ms/query.
- For recall-oriented benchmarks raise `BRAINROUTER_RECALL_TOP_RESULTS` and/or set
  `BRAINROUTER_RELEVANCE_JUDGE_ENABLED=false`; the retriever (FTS+vector+RRF) is
  competitive with the strongest baseline on recall@20 and nDCG.

## Not done (by choice)

- The 100k splits are not generated (~10× the 10k size; generate on demand).
- BrainRouter was not run on the other 10k splits (`ps-rm`, `os-fm`, `os-rm`) or
  on larger record bounds; the server is shut down. Restart it (above) to extend.
