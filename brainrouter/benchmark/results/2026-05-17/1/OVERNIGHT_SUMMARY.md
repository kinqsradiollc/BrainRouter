# Overnight Benchmark Run Summary

**Run Timestamp:** 2026-05-17T19:20:41.105Z
**Destination Folder:** `/Users/anhdang/Documents/Github/BrainRouter/mcp/benchmark/results/2026-05-17/1`

| Benchmark Name | Command | Status | Duration (Mins) | Notes |
| :--- | :--- | :---: | :---: | :--- |
| **In-Process SQLite Scale Benchmark** | `npx tsx benchmark/scale-eval.ts` | ✅ SUCCESS | 11.91 | Completed successfully |
| **Real Embeddings Quality Suite (Wasm MiniLM)** | `npx tsx benchmark/real-embeddings-eval.ts` | ✅ SUCCESS | 0.20 | Completed successfully |
| **100k Concurrency Load Test** | `npx tsx benchmark/load-100k-bench.ts` | ✅ SUCCESS | 29.91 | Completed successfully |
| **End-to-End Generative Evaluation** | `npx tsx benchmark/end-to-end-bench.ts` | ✅ SUCCESS | 2.60 | Completed successfully |
| **Full Quality Retrieval Suite (Config comparisons)** | `npx tsx benchmark/quality-eval.ts` | ✅ SUCCESS | 0.40 | Completed successfully |
| **LongMemEval-S (FTS-only)** | `npx tsx benchmark/longmemeval-bench.ts fts` | ✅ SUCCESS | 0.17 | Completed successfully |
| **LongMemEval-S (BM25+Vector Hybrid)** | `npx tsx benchmark/longmemeval-bench.ts hybrid` | ✅ SUCCESS | 19.32 | Completed successfully |
| **LongMemEval-S (Hybrid + Reranking Stage 3)** | `npx tsx benchmark/longmemeval-bench.ts hybrid+rerank` | ✅ SUCCESS | 19.66 | Completed successfully |
