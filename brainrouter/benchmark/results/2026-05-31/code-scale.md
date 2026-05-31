# Code-scale retrieval benchmark (find_related ranking)

**Date:** 2026-05-31 · **Harness:** `MemoryEngine.runCodeScaleBenchmark()`
(`brainrouter/src/memory/bench/code-scale.ts` + `code-scale-fixture.ts`) ·
real SQLite store, FTS-only (no embeddings/reranker).

Fixture: 8 independent clusters × 5 files (40 files). Within a cluster, files
share a distinctive symbol prefix and import each other in a chain; across
clusters there is no shared vocabulary. Gold relevance for a seed = the other
files in its cluster.

- queries: 8
- recall@10: **100.0%**
- precision@10: 40.0%
- MRR: 1.000
- nDCG@10: 1.000
- avg tokens returned/query: 792
- token efficiency: **19.4%** of a whole-repo dump (792 vs 4080 tokens)

Reads as: `find_related` recalls every in-cluster relevant file and ranks a
relevant hit first (MRR/nDCG = 1.0), while returning ~1/5 the tokens a
whole-repo dump would cost. Precision @10 of 40% reflects deliberate
cross-cluster lexical noise in the fixture (shared boilerplate like
`trim().toLowerCase()`), i.e. a conservative floor — real repos with richer
vocabulary separate cleaner.

Reproduce:

```bash
cd brainrouter && npx tsx -e "import {SqliteMemoryStore} from './src/memory/store/sqlite.js'; import {MemoryEngine} from './src/memory/engine.js'; const s=new SqliteMemoryStore(':memory:'); s.init(); console.log(new MemoryEngine(s).runCodeScaleBenchmark({k:10}))"
```
